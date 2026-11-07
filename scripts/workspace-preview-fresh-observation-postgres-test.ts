import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';

let phase = 'setup', groups = 0, complete = false;
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

async function workspacePreviewFreshObservationPostgresTest() {
  await withNativeCopyMetadataOwnerFixture(async h => {
    const { readRequestWorkspacePathImportPreparationPlan: read } =
      await import('../app/lib/files/workspace-path-import-operation-preview');
    const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
    const protectedDoc = await h.upload('fresh-preview-protected.md', Buffer.from('# Preserve native bytes\n'));
    const snapshot = async () => (await h.admin.query(`SELECT to_jsonb(s) AS state,s.xmin::text AS xmin,
      (SELECT count(*) FROM workspace_file_operation_batches)::int AS batches,
      (SELECT count(*) FROM workspace_path_import_preparations)::int AS preparations
      FROM collaboration_yjs_states s WHERE s.document_id=$1`, [protectedDoc.documentId])).rows;
    for (const kind of ['rename', 'delete', 'revoked'] as const) {
      phase = kind;
      const sourcePath = `fresh-preview-${randomUUID()}.txt`, destinationPath = `fresh-preview-${randomUUID()}.txt`;
      const file = path.join(h.source.rootPath, sourcePath), bytes = Buffer.from('Preserve this ordinary non-Markdown file.\n');
      await fs.writeFile(file, bytes, { flag: 'wx' });
      const before = await snapshot(), original = await h.request(h.source, 'owner');
      const token = (await h.admin.query('SELECT token FROM session WHERE id=$1', ['session-owner'])).rows[0].token as string;
      const question = { workspaceId: h.source.workspaceId, kind: kind === 'rename' ? 'rename' as const : 'delete' as const,
        selections: [kind === 'rename' ? { sourcePath, destinationPath } : { sourcePath }],
        expected: { userId: 'owner', sessionId: 'session-owner', impersonatedBy: null,
          scope: captureWorkspaceOperationJobScope(h.source) } };
      let delayed = false, delayMs = 0, revoked = false, writes = 0;
      const previousInfo = console.info;
      console.info = (...args: unknown[]) => {
        previousInfo(...args);
        if (delayed || args[0] !== '[source-preview]' || typeof args[1] !== 'string') return;
        const measurement = JSON.parse(args[1]) as { complete?: boolean };
        if (!measurement.complete) return;
        delayed = true;
        // The real collector has completed and closed its SQL phases here.
        // Delay only diagnostics/CPU work outside SQL; keep the real clock,
        // original credentials, queries and authorization decisions intact.
        const started = performance.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_250);
        delayMs = performance.now() - started;
      };
      try {
        await h.withProbe(async event => {
          if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[\s\S]*?\bSET\b)\b/iu.test(event.text)) writes++;
          if (kind === 'revoked' && delayed && !revoked && event.text.includes('AS token_hash')) {
            await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [randomUUID(), 'session-owner']);
            revoked = true;
          }
        }, async () => {
          if (kind === 'revoked') {
            await assert.rejects(read(original, question), error => error instanceof Error
              && Reflect.get(error, 'code') === 'PRINCIPAL_AUTH_REVOKED' && Reflect.get(error, 'status') === 401);
          } else {
            const plan = await read(original, question);
            assert.equal(plan.readiness, 'native-ready');
          }
        });
        assert(delayed && delayMs >= 5_000, 'The observation must really outlive the original capture.');
        assert.equal(revoked, kind === 'revoked');
      } finally {
        console.info = previousInfo;
        if (revoked) await h.admin.query('UPDATE session SET token=$1 WHERE id=$2', [token, 'session-owner']);
        assert.equal(writes, 0);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await fs.readFile(file), bytes);
        await assert.rejects(fs.stat(path.join(h.source.rootPath, destinationPath)), { code: 'ENOENT' });
      }
      groups++;
      console.log(JSON.stringify({ suite: 'workspace-preview-fresh-observation', phase, passed: true,
        realDelayMs: Math.round(delayMs), actualPostgresAndAuthorization: true,
        nativeRowsXminOriginalFileAndOperationCountsPreserved: true }));
    }
  });
  assert.equal(groups, 3); complete = true;
  console.log(JSON.stringify({ suite: 'workspace-preview-fresh-observation-summary', passed: true, groups }));
}

void workspacePreviewFreshObservationPostgresTest().catch(error => {
  console.error('Fresh preview observation failed:', { phase, groups,
    name: error instanceof Error ? error.name : 'NonError',
    code: error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined });
  process.exitCode = 1;
});
