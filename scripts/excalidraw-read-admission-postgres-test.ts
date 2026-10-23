import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

// Controlled genuine contention, not attribution of the original browser locker.
// Domain/service regression only; HTTP authentication remains a browser boundary.
type Outcome<T> = { value: T } | { error: unknown };
type Backend = { pid: number; start: string };
type LockRow = Backend & { mode: string; granted: boolean; blockers: number[]; wait_event_type: string | null; age_ms: number };
const errorCode = (error: unknown): unknown => error && typeof error === 'object'
  ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const portable = (id: string) => JSON.stringify({ type: 'excalidraw', version: 2,
  elements: [{ id: `image-${id}`, type: 'image', fileId: id, version: 1, versionNonce: 1, isDeleted: false }],
  appState: { viewBackgroundColor: '#ffffff' }, files: { [id]: { id, mimeType: 'image/png',
    dataURL: `data:image/png;base64,${png.toString('base64')}`, created: 42, version: 1 } } });
let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

export async function excalidrawReadAdmissionPostgresTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { openDb } = await import('../app/lib/db');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { getExcalidrawDocument: get, createExcalidrawDocument: create, ExcalidrawDocumentError } = await import('../app/lib/excalidraw-collaboration/scene-service');
    const { importExcalidrawDocumentFile: importScene } = await import('../app/lib/excalidraw-collaboration/portable-import');
    const { assertExcalidrawLifecycleAvailable } = await import('../app/lib/excalidraw-collaboration/lifecycle-availability');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const { readInitializedPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace: WorkspaceContext = h.destination;
    const actor = { userId: 'member', actorId: 'member', actorType: 'user' as const, sessionId: 'session-member' };
    const member = resolveWorkspaceActor({ id: 'member', role: 'user', email: 'member@principal.test' });
    const refreshResults: boolean[] = [];
    const beforeRead = async (): Promise<WorkspaceContext> => {
      const fresh = await readInitializedPostgresWorkspaceForActor(member, workspace.workspaceId);
      refreshResults.push(Boolean(fresh?.permissions.canRead));
      if (!fresh?.permissions.canRead) throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403,
        'The actual persisted workspace membership no longer permits this service read.');
      return fresh;
    };
    assert.equal((await beforeRead()).workspaceId, workspace.workspaceId);
    const key = BigInt.asUintN(64, BigInt(collaborationAdmissionLockKey(workspace.workspaceId)));
    const keyParts = [(key >> BigInt(32)).toString(), (key & BigInt('4294967295')).toString()];
    const locks = async (): Promise<LockRow[]> => (await h.admin.query<LockRow>(`SELECT l.pid,
      extract(epoch FROM a.backend_start)::text AS start,l.mode,l.granted,pg_blocking_pids(l.pid) AS blockers,a.wait_event_type,
      (extract(epoch FROM (clock_timestamp()-a.query_start))*1000)::float8 AS age_ms
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1 AND a.application_name=$3 ORDER BY l.pid,l.mode`,
    [...keyParts, h.applicationName])).rows;
    const tables = ['file_collaboration_lineages', 'collaboration_documents', 'file_revisions', 'file_revision_contents', 'file_version_blobs',
      'collaboration_excalidraw_states', 'collaboration_excalidraw_operations', 'collaboration_excalidraw_assets',
      'collaboration_excalidraw_agent_operations', 'collaboration_excalidraw_creates', 'collaboration_excalidraw_checkpoint_intents',
      'collaboration_excalidraw_restores', 'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets'];
    const rows = async () => {
      const result: Record<string, unknown> = {};
      for (const table of tables) result[table] = (await h.admin.query(`SELECT to_jsonb(t) AS row,xmin::text AS xmin FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return result;
    };
    const files = async () => {
      const result: Record<string, unknown> = {};
      const visit = async (file: string): Promise<void> => {
        const stat = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) { result[file] = null; return; }
        assert(!stat.isSymbolicLink());
        result[file] = { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
          ...(stat.isFile() ? { bytes: (await fs.readFile(file)).toString('base64') } : {}) };
        if (stat.isDirectory()) for (const entry of (await fs.readdir(file)).sort()) await visit(path.join(file, entry));
      };
      await visit(workspace.rootPath); await visit(path.join(h.dataRoot, 'collaboration-assets', 'excalidraw'));
      return result;
    };
    const assertBusy = (error: unknown): void => {
      assert.equal(errorCode(error), 'EXCALIDRAW_FILE_LIFECYCLE_BUSY');
      assert(error instanceof Error && 'status' in error); assert.equal(error.status, 409);
    };
    const withSharedReader = async (operation: (reader: Backend, release: () => Promise<void>) => Promise<void>): Promise<void> => {
      const connection: SqlConnection = await openDb(); let transaction = false, failed = false, failure: unknown;
      let backend: Backend | undefined;
      const inspect = async (): Promise<Backend> => {
        const row = await connection.get(`SELECT pg_backend_pid() AS pid,extract(epoch FROM a.backend_start)::text AS start,
          current_setting('transaction_read_only') AS readonly,pg_current_xact_id_if_assigned()::text AS xid,
          current_schema() AS schema FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`) as Backend & { readonly: string; xid: string | null; schema: string };
        assert.equal(row.readonly, 'on'); assert.equal(row.xid, null); assert.equal(row.schema, h.schema);
        if (backend) assert.deepEqual({ pid: row.pid, start: row.start }, backend);
        return { pid: row.pid, start: row.start };
      };
      const release = async () => {
        if (!transaction) return;
        const actual = backend; let failed = false, failure: unknown;
        if (actual) try { await inspect(); } catch (error) { failed = true; failure = error; }
        try { await connection.run('ROLLBACK'); transaction = false; }
        catch (error) { throw failed ? new AggregateError([failure, error], 'Reader verification and rollback both failed.') : error; }
        if (actual) assert(!(await locks()).some(row => row.pid === actual.pid && row.start === actual.start), 'The controlled read fence must actually release.');
        if (failed) throw failure;
      };
      try {
        await connection.run('BEGIN READ ONLY'); transaction = true;
        await connection.run("SET LOCAL statement_timeout='5s'"); await connection.run("SET LOCAL lock_timeout='4s'");
        await connection.get('SELECT pg_advisory_xact_lock_shared($1::bigint)', [collaborationAdmissionLockKey(workspace.workspaceId)]);
        backend = await inspect();
        const actual = backend;
        const held = (await locks()).filter(row => row.pid === actual.pid && row.start === actual.start);
        assert.equal(held.length, 1); assert.equal(held[0].mode, 'ShareLock'); assert.equal(held[0].granted, true);
        await operation(backend, release);
      } catch (error) { failed = true; failure = error; }
      finally {
        const cleanup: unknown[] = [];
        try { await release(); } catch (error) { cleanup.push(error); }
        try { await connection.close(); } catch (error) { cleanup.push(error); }
        if (cleanup.length) throw new AggregateError(failed ? [failure, ...cleanup] : cleanup, 'Controlled Scene-read fence closure was not confirmed.');
      }
      if (failed) throw failure;
    };
    const start = <T>(operation: () => Promise<T>) => {
      let settled: Outcome<T> | undefined;
      const began = performance.now();
      const pending: Promise<Outcome<T>> = operation().then(value => { settled = { value }; return settled; }, error => { settled = { error }; return settled; });
      const waitForWriter = async (reader: Backend): Promise<LockRow> => {
        const deadline = performance.now() + 3000;
        do {
          const candidates = (await locks()).filter(row => row.pid !== reader.pid && row.mode === 'ExclusiveLock' && !row.granted);
          assert(candidates.length <= 1, 'This isolated service call must have one identifiable waiting backend.');
          if (candidates[0]) {
            const waiting = candidates[0]; assert.equal(waiting.wait_event_type, 'Lock'); assert(waiting.blockers.includes(reader.pid));
            assert.equal(settled, undefined); return waiting;
          }
          if (settled) assert.fail(`getExcalidrawDocument settled before a genuine ExclusiveLock wait: ${JSON.stringify('error' in settled
            ? { name: settled.error instanceof Error ? settled.error.name : 'NonError', code: errorCode(settled.error) } : { returned: true })}`);
          await new Promise<void>(resolve => setImmediate(resolve)); // The actual pg_locks row, not a sleep, synchronizes release/revocation.
        } while (performance.now() < deadline);
        assert.fail('The genuine Scene admission wait was not observable within three seconds.');
      };
      return { pending, waitForWriter, elapsed: () => performance.now() - began };
    };
    const assertReleased = async (waiting: Backend) => {
      assert(!(await locks()).some(row => row.pid === waiting.pid && row.start === waiting.start));
      const remaining = (await h.admin.query(`SELECT state,xact_start FROM pg_stat_activity
        WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2`, [waiting.pid, waiting.start])).rows;
      assert(remaining.length === 0 || remaining.length === 1 && remaining[0].state === 'idle' && remaining[0].xact_start === null,
        'The service must finish its transaction and retain no admission lock; fixture closure subsequently ends the real pool.');
    };
    const group = async (name: string, operation: () => Promise<void>) => {
      currentCase = name; await operation(); console.log(`PASS excalidraw-read-admission ${++groups}: ${name}`);
    };

    await group('current-rights getDoc waits once for a genuine shared fence and preserves initialized D/L, scene and assets', async () => {
      const target = 'wait-initialized.excalidraw';
      const initialized = await importScene({ workspace, actor, path: target, content: portable('wait-initialized-asset') });
      const baseline = await get({ workspace, path: target, actor, beforeRead }); assert.equal(baseline.degradedReason, null);
      const identity = (await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE id=$1', [initialized.documentId])).rows;
      const beforeRows = await rows(), beforeFiles = await files();
      let dml = 0, acquisitions = 0;
      await h.withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) dml++;
        if (/\bpg_advisory_xact_lock\(/u.test(event.text) && !/\bpg_try_advisory/u.test(event.text)
          && event.values[0] === collaborationAdmissionLockKey(workspace.workspaceId)) {
          acquisitions++;
          const settings = (await event.raw("SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout")).rows[0];
          assert.equal(settings.lock_timeout, '4s'); assert.equal(settings.statement_timeout, '5s');
        }
      }, async () => withSharedReader(async (reader, release) => {
        const request = start(() => get({ workspace, path: target, actor, beforeRead }));
        try {
          const waiting = await request.waitForWriter(reader); assert.equal(dml, 0);
          await release(); const outcome = await request.pending;
          assert('value' in outcome, JSON.stringify('error' in outcome ? { code: errorCode(outcome.error) } : {}));
          assert.equal(outcome.value.documentId, initialized.documentId);
          for (const field of ['lifecycleGeneration', 'sceneSequence', 'canonicalHash', 'elements', 'appState', 'assets'] as const) {
            assert.deepEqual(outcome.value[field], baseline[field]);
          }
          assert.equal(acquisitions, 1, 'One real lock wait, not a retried whole read or bootstrap.');
          await assertReleased(waiting);
        } finally { await release(); await request.pending; }
      }));
      assert.equal(dml, 0); assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await files(), beforeFiles);
      assert.deepEqual((await h.admin.query('SELECT id,lineage_id FROM collaboration_documents WHERE id=$1', [initialized.documentId])).rows, identity);
    });

    await group('a persistent shared fence reaches the existing four-second bound before any portable bootstrap DML', async () => {
      const target = 'timeout-unregistered.excalidraw'; await fs.writeFile(path.join(workspace.rootPath, target), portable('timeout-asset'));
      const beforeRows = await rows(), beforeFiles = await files(); let dml = 0;
      await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) dml++; }, async () => withSharedReader(async (reader, release) => {
        const request = start(() => get({ workspace, path: target, actor, beforeRead }));
        try {
          const waiting = await request.waitForWriter(reader), observedAt = performance.now();
          const outcome = await request.pending; assert('error' in outcome); assertBusy(outcome.error);
          assert(outcome.error instanceof Error && outcome.error.cause instanceof Error);
          assert.equal(errorCode(outcome.error.cause.cause), '55P03', 'The named Busy must preserve the actual PG admission-lock timeout cause.');
          const lockElapsed = waiting.age_ms + performance.now() - observedAt;
          assert(lockElapsed >= 3750 && lockElapsed < 5000, `The actual admission lock wait must remain bounded by 4s/5s: ${lockElapsed}ms.`);
          assert(request.elapsed() < 6000, 'No whole-service retry may extend the single bounded lock attempt.');
          const retained = (await locks()).filter(row => row.pid === reader.pid && row.start === reader.start);
          assert.equal(retained.length, 1); assert.equal(retained[0].mode, 'ShareLock'); assert.equal(retained[0].granted, true);
          await assertReleased(waiting); assert.equal(dml, 0);
          assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await files(), beforeFiles);
        } finally { await release(); await request.pending; }
      }));
    });

    await group('default getDoc, availability, create and import remain fail-fast with no current-rights callback', async () => {
      const target = 'default-unregistered.excalidraw'; await fs.writeFile(path.join(workspace.rootPath, target), portable('default-asset'));
      const beforeRows = await rows(), beforeFiles = await files();
      await withSharedReader(async () => {
        for (const operation of [() => get({ workspace, path: target, actor }),
          () => assertExcalidrawLifecycleAvailable(workspace.workspaceId, target),
          () => create({ workspace, actor, path: 'default-create.excalidraw', idempotencyKey: randomUUID() }),
          () => importScene({ workspace, actor, path: 'default-import.excalidraw', content: portable('default-import-asset') })]) {
          const began = performance.now(); await assert.rejects(operation, (error: unknown) => { assertBusy(error); return true; });
          assert(performance.now() - began < 1500, 'An existing default writer/bootstrap path must not opt into the read-only wait policy.');
        }
        assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await files(), beforeFiles);
      });
    });

    await group('real workspace read revocation while waiting is refreshed after release before any bootstrap mutation', async () => {
      const target = 'revoked-unregistered.excalidraw'; await fs.writeFile(path.join(workspace.rootPath, target), portable('revoked-asset'));
      assert.equal((await beforeRead()).permissions.canRead, true);
      const beforeRows = await rows(), beforeFiles = await files(); refreshResults.length = 0; let revoked = false, dml = 0;
      await h.withProbe(async event => { if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) dml++; }, async () => withSharedReader(async (reader, release) => {
        const request = start(() => get({ workspace, path: target, actor, beforeRead }));
        try {
          const waiting = await request.waitForWriter(reader);
          const changed = await h.admin.query(`UPDATE canvas_workspace_members SET can_read=0,can_write=0
            WHERE workspace_id=$1 AND user_id='member' AND can_read=1 AND can_write=1 AND can_manage=0 RETURNING workspace_id`, [workspace.workspaceId]);
          assert.equal(changed.rowCount, 1); revoked = true;
          await release(); const outcome = await request.pending; assert('error' in outcome);
          assert.equal(errorCode(outcome.error), 'EXCALIDRAW_PERMISSION_DENIED');
          assert(outcome.error instanceof ExcalidrawDocumentError); assert.equal(outcome.error.status, 403);
          assert(refreshResults.includes(false), 'The callback must actually resolve denied membership from current PostgreSQL rows after waiting.');
          assert.equal(dml, 0); assert.deepEqual(await rows(), beforeRows); assert.deepEqual(await files(), beforeFiles);
          await assertReleased(waiting);
        } finally {
          await release(); await request.pending;
          if (revoked) assert.equal((await h.admin.query(`UPDATE canvas_workspace_members SET can_read=1,can_write=1
            WHERE workspace_id=$1 AND user_id='member' AND can_read=0 AND can_write=0 AND can_manage=0`, [workspace.workspaceId])).rowCount, 1);
        }
      }));
    });
  });
  assert.equal(groups, 4); completed = true;
  console.log('Excalidraw read admission: 4 genuine PostgreSQL service groups; controlled shared fence, no original-locker or HTTP-authentication claim.');
}

void excalidrawReadAdmissionPostgresTest().catch(error => {
  console.error('Excalidraw read admission fixture failed:', { case: currentCase, groups,
    name: error instanceof Error ? error.name : 'NonError', code: errorCode(error), message: error instanceof Error ? error.message : undefined });
  process.exitCode = 1;
});
