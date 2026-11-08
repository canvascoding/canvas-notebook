import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let currentCase = 'setup', groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function workspacePreviewReadRecoveryPostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readRequestWorkspacePathImportPreparationPlan: read, WorkspacePathImportPreviewError } =
      await import('../app/lib/files/workspace-path-import-operation-preview');
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const pool = getPostgresRuntimeQueryable(); assert(pool);
    const protectedDoc = await h.upload('protected-preview-source.md', Buffer.from('# Keep this native source\n'));
    for (const phase of ['scan-commit-loss', 'scan-close-loss', 'transient', 'advisory', 'persistent', 'revoked', 'root-changed', 'rollback-loss', 'close-loss', 'commit-loss', 'capture', 'expected-actor', 'expected-session', 'expected-impersonation', 'initial-root-changed'] as const) {
      currentCase = phase;
      const sourcePath = `preview-original-${randomUUID()}.txt`, destinationPath = `preview-target-${randomUUID()}.txt`;
      const bytes = Buffer.from('Keep all original file bytes.\n');
      const file = path.join(h.source.rootPath, sourcePath);
      await fs.writeFile(file, bytes, { flag: 'wx' });
      const original = await h.request(h.source, 'owner');
      const question = { workspaceId: h.source.workspaceId, kind: 'rename' as const, selections: [{ sourcePath, destinationPath }],
        expected: { userId: 'owner', sessionId: 'session-owner', impersonatedBy: null as string | null, scope: captureWorkspaceOperationJobScope(h.source) } };
      if (phase === 'expected-actor') question.expected.userId = 'wrong-original-actor';
      if (phase === 'expected-session') question.expected.sessionId = 'wrong-original-session';
      if (phase === 'expected-impersonation') question.expected.impersonatedBy = 'wrong-original-impersonator';
      const snapshot = async () => (await h.admin.query(`SELECT to_jsonb(y) AS state,y.xmin::text AS xmin,
        (SELECT count(*) FROM workspace_file_operation_batches)::int AS batches,
        (SELECT count(*) FROM workspace_path_import_preparations)::int AS preparations
        FROM collaboration_yjs_states y WHERE y.document_id=$1`, [protectedDoc.documentId])).rows;
      const before = await snapshot();
      const token = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['session-owner'])).rows[0].token as string;
      let armed = false, held = false, rollbacks = 0, factories = 0, readPhases = 0, closed = 0, lost = false, postLossQueries = 0;
      const events: string[] = [];
      if (phase === 'initial-root-changed') await h.admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',
        [`organizations/principal-org/changed-${randomUUID()}`, h.source.workspaceId]);
      // The shared probe intentionally leaves pg-pool's string/callback overload
      // untouched. Observe that real factory query without altering any args,
      // result, connection or authentication decision.
      const previousQuery = pool.query;
      pool.query = ((...args: unknown[]) => {
        if (lost) postLossQueries++;
        if (typeof args[0] === 'string' && args[0].startsWith('SELECT current_schema() AS schema,(SELECT oid::bigint')) {
          factories++; events.push('factory');
        }
        return Reflect.apply(previousQuery, pool, args);
      }) as typeof pool.query;
      try {
        const result = await h.withProbe(async event => {
          if (lost) postLossQueries++;
          if (event.text === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE') readPhases++;
          if (!armed && event.text.includes("AS token_hash") && event.text.includes('database_oid')) {
            armed = true;
            if (phase !== 'commit-loss' && !phase.startsWith('scan-') && !phase.startsWith('expected-') && phase !== 'initial-root-changed') {
              await h.admin.query('BEGIN'); held = true;
              if (phase === 'advisory') await h.admin.query('SELECT pg_advisory_xact_lock($1::bigint)',
                [collaborationAdmissionLockKey(h.source.workspaceId)]);
              else await h.admin.query("SELECT organization_id FROM canvas_organization_settings WHERE organization_id='principal-org' FOR NO KEY UPDATE");
            }
          } else if (armed && phase === 'scan-close-loss' && readPhases === 2 && event.text === 'COMMIT') {
            const release = event.client.release;
            event.client.release = (error?: Error | boolean) => {
              event.client.release = release; release.call(event.client, error);
              lost = true; throw new Error('Lost genuine source-scan connection release acknowledgement.');
            };
          } else if (armed && (phase === 'commit-loss' || phase === 'scan-commit-loss' && readPhases === 2) && event.text === 'COMMIT') {
            lost = true; throw new Error('Lost genuine preview observation COMMIT acknowledgement.');
          } else if (held && event.text === 'ROLLBACK') {
            rollbacks++; events.push('rollback');
            const release = event.client.release;
            event.client.release = (error?: Error | boolean) => {
              event.client.release = release; release.call(event.client, error); closed++; events.push('close');
              if (phase === 'close-loss') { lost = true; throw new Error('Lost genuine preview connection release acknowledgement.'); }
            };
            if (phase !== 'persistent') {
              await h.admin.query('ROLLBACK'); held = false;
              if (phase === 'revoked') await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [randomUUID(), 'session-owner']);
              if (phase === 'root-changed') await h.admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',
                [`organizations/principal-org/changed-${randomUUID()}`, h.source.workspaceId]);
              if (phase === 'capture') {
                original.headers.set('authorization', 'Bearer invalid-late-header');
                question.workspaceId = 'invalid-late-workspace'; question.selections[0].sourcePath = '../invalid-late-path';
              }
              if (phase === 'rollback-loss') { lost = true; throw new Error('Lost genuine preview ROLLBACK acknowledgement.'); }
            }
          }
        }, async () => {
          if (phase === 'persistent') {
            await assert.rejects(read(original, question), error => error instanceof WorkspacePathImportPreviewError
              && error.code === 'PATH_IMPORT_PREVIEW_BUSY' && error.status === 409); return null;
          }
          if (phase === 'revoked' || phase === 'root-changed' || phase.startsWith('expected-') || phase === 'initial-root-changed') {
            await assert.rejects(read(original, question), error => error instanceof Error
              && Reflect.get(error, 'code') === (phase === 'revoked' ? 'PRINCIPAL_AUTH_REVOKED' : 'PREVIEW_STALE')); return null;
          }
          if (phase === 'rollback-loss') { await assert.rejects(read(original, question), AggregateError); return null; }
          if (phase === 'commit-loss' || phase === 'close-loss' || phase.startsWith('scan-')) { await assert.rejects(read(original, question)); return null; }
          return read(original, question);
        });
        assert(armed); assert.equal(postLossQueries, 0);
        assert.equal(rollbacks, phase === 'commit-loss' || phase.startsWith('scan-') || phase.startsWith('expected-') || phase === 'initial-root-changed' ? 0 : phase === 'persistent' ? 3 : 1);
        const attempts = phase === 'persistent' ? 3
          : phase === 'transient' || phase === 'advisory' || phase === 'capture' || phase === 'root-changed' || phase === 'revoked' ? 2 : 1;
        // Each actual SQL phase now has its own genuine credential capture.
        // A revoked retry fails authentication before it can capture a realm.
        assert.equal(factories, readPhases + attempts - (phase === 'revoked' ? 1 : 0));
        if (phase === 'transient' || phase === 'advisory' || phase === 'capture' || phase === 'root-changed' || phase === 'persistent') {
          assert.equal(closed, rollbacks);
          assert(events.indexOf('close') > events.indexOf('rollback'));
          const closedAt = events.indexOf('close');
          assert(events.indexOf('factory', closedAt + 1) > closedAt);
        }
        if (result) assert.equal(result.readiness, 'native-ready');
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await fs.readFile(file), bytes);
        await assert.rejects(fs.stat(path.join(h.source.rootPath, destinationPath)), { code: 'ENOENT' });
      } finally {
        pool.query = previousQuery;
        if (held) await h.admin.query('ROLLBACK');
        if (phase === 'revoked') await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [token, 'session-owner']);
        if (phase === 'root-changed' || phase === 'initial-root-changed') await h.admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',
          [h.source.rootRelativePath, h.source.workspaceId]);
      }
      groups++;
      console.log(JSON.stringify({ suite: 'workspace-preview-read-recovery', phase, passed: true, factories, readPhases, rollbacks,
        originalFilesNativeRowsXminAndOperationCountsUnchanged: true, noSqlAfterUnconfirmedOutcome: postLossQueries === 0 }));
    }
  });
  assert.equal(groups, 15); completed = true;
  console.log(JSON.stringify({ suite: 'workspace-preview-read-recovery-summary', passed: true, groups, actualPostgresAndAuthorization: true }));
}
void workspacePreviewReadRecoveryPostgresTest().catch(error => {
  console.error('Preview read recovery failed:', { phase: currentCase, groups, name: error instanceof Error ? error.name : 'NonError',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
    ...(error instanceof assert.AssertionError ? {
      actual: ['number', 'boolean', 'string'].includes(typeof error.actual) ? String(error.actual).slice(0, 128) : 'structured',
      expected: ['number', 'boolean', 'string'].includes(typeof error.expected) ? String(error.expected).slice(0, 128) : 'structured',
      frames: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 3),
    } : {}) }); process.exitCode = 1;
});
