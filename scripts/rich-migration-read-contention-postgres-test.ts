import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let completed = false, groups = 0, currentCase = 'setup';
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });

async function richMigrationReadContentionPostgresTest(): Promise<void> {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readAuthenticatedRichMigrationNative: readNative, createAuthenticatedRichMigrationDomain } =
      await import('../app/lib/collaboration/rich-migration-domain');
    const { collaborationUpdateStateProof } = await import('../app/lib/collaboration/state-proof');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    for (const phase of ['discovery', 'current', 'persistent', 'revoked', 'root-changed', 'commit-loss', 'rollback-loss', 'close-loss'] as const) {
      currentCase = phase;
      const file = `read-contention-${randomUUID()}.md`;
      const uploaded = await h.upload(file, Buffer.from('# Native content\n\nPreserve exactly.\n'));
      const request = await h.request(h.source, 'owner');
      const initial = await readNative(request, h.source.workspaceId, file);
      const migration = { requestId: randomUUID(), expectedDocumentId: initial.state.documentId,
        expectedLifecycleGeneration: initial.state.lifecycleGeneration, documentSequence: initial.state.documentSequence,
        stateProof: collaborationUpdateStateProof(initial.state.yjsState, Y)! };
      const domain = createAuthenticatedRichMigrationDomain(request,
        { workspaceId: h.source.workspaceId, path: file, migration, action: 'advance' }, initial);
      const snapshot = async () => (await h.admin.query(`SELECT to_jsonb(y) AS state,y.xmin::text AS xmin,
        (SELECT count(*) FROM collaboration_yjs_state_backups b WHERE b.document_id=y.document_id)::int AS backups,
        (SELECT count(*) FROM collaboration_admission_targets t WHERE t.document_id=y.document_id)::int AS targets
        FROM collaboration_yjs_states y WHERE y.document_id=$1`, [uploaded.documentId])).rows;
      const before = await snapshot();
      const token = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['session-owner'])).rows[0].token as string;
      let armed = false, held = false, rollbacks = 0, lost = false, postLossQueries = 0;
      try {
        const observe = () => phase === 'discovery' ? readNative(request, h.source.workspaceId, file) : domain.read();
        const result = await h.withProbe(async event => {
          if (lost) postLossQueries++;
          if (!armed && event.text.includes('FROM collaboration_documents d FULL JOIN') && event.values[1] === file) {
            armed = true;
            if (phase !== 'commit-loss') {
              await h.admin.query('BEGIN'); held = true;
              await h.admin.query('SELECT id FROM collaboration_documents WHERE id=$1 FOR UPDATE', [uploaded.documentId]);
            }
          } else if (armed && phase === 'commit-loss' && event.text === 'COMMIT') {
            lost = true;
            throw new Error('Lost actual observation COMMIT response.');
          } else if (held && event.text === 'ROLLBACK') {
            rollbacks++;
            if (phase !== 'persistent') {
              await h.admin.query('ROLLBACK'); held = false;
              if (phase === 'revoked') await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [randomUUID(), 'session-owner']);
              if (phase === 'root-changed') await h.admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',
                [`organizations/principal-org/changed-${randomUUID()}`, h.source.workspaceId]);
              if (phase === 'rollback-loss') { lost = true; throw new Error('Lost actual observation ROLLBACK response.'); }
              if (phase === 'close-loss') {
                const release = event.client.release;
                event.client.release = (error?: Error | boolean) => {
                  event.client.release = release;
                  release.call(event.client, error); lost = true;
                  throw new Error('Lost actual observation connection release response.');
                };
              }
            }
          }
        }, async () => {
          if (phase === 'discovery') {
            await assert.rejects(observe(), error => error instanceof Error && Reflect.get(error, 'code') === 'PRINCIPAL_BUSY');
            return null;
          }
          if (phase === 'persistent') {
            await assert.rejects(observe(), error => error instanceof Error
              && Reflect.get(error, 'code') === 'ADMISSION_CONFLICT' && Reflect.get(error, 'status') === 503);
            return null;
          }
          if (phase === 'revoked' || phase === 'commit-loss') {
            await assert.rejects(observe(), error => error instanceof Error
              && Reflect.get(error, 'code') === (phase === 'revoked' ? 'PRINCIPAL_AUTH_REVOKED' : 'ADMISSION_RECOVERY_REQUIRED'));
            return null;
          }
          if (phase === 'rollback-loss') { await assert.rejects(observe(), AggregateError); return null; }
          if (phase === 'root-changed' || phase === 'close-loss') {
            await assert.rejects(observe(), error => error instanceof Error && (phase === 'root-changed'
              ? Reflect.get(error, 'code') === 'ADMISSION_SCOPE_CHANGED'
              : error.message === 'Lost actual observation connection release response.'));
            return null;
          }
          return observe();
        });
        assert(armed); assert.equal(rollbacks, phase === 'persistent' ? 3 : phase === 'commit-loss' ? 0 : 1);
        if (phase === 'commit-loss' || phase === 'rollback-loss' || phase === 'close-loss') {
          assert(lost); assert.equal(postLossQueries, 0, 'Unconfirmed transaction outcome must never start another observation.');
        }
        if (phase === 'current') {
          assert(result);
          assert.equal(result.state.documentId, uploaded.documentId);
          assert.equal(result.state.lifecycleGeneration, initial.state.lifecycleGeneration);
        }
        assert.deepEqual(await snapshot(), before);
      } finally {
        if (held) await h.admin.query('ROLLBACK');
        if (phase === 'revoked') await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [token, 'session-owner']);
        if (phase === 'root-changed') await h.admin.query('UPDATE canvas_workspaces SET root_relative_path=$1 WHERE id=$2',
          [h.source.rootRelativePath, h.source.workspaceId]);
      }
      groups++;
      console.log(JSON.stringify({ suite: 'rich-migration-read-contention', phase, passed: true,
        actualPostgresRowLock: phase !== 'commit-loss', actualRollbacks: rollbacks,
        nativeRowsXminAndBytesUnchanged: true,
        ...(['commit-loss', 'rollback-loss', 'close-loss'].includes(phase) ? { noRetryAfterUnconfirmedOutcome: postLossQueries === 0 } : {}) }));
    }
  });
  assert.equal(groups, 8); completed = true;
  console.log(JSON.stringify({ suite: 'rich-migration-read-contention-summary', passed: true, groups,
    actualPostgresAndAuthorization: true, compiledNext: false }));
}

void richMigrationReadContentionPostgresTest().catch(error => {
  console.error('Rich migration read contention failed:', { case: currentCase, groups,
    name: error instanceof Error ? error.name : 'NonError',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined });
  process.exitCode = 1;
});
