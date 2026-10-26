import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import { withDocumentReadToolDispatchFixture } from './helpers/document-read-tool-dispatch-fixture';
import { measureDocumentOperation, withDocumentOperationMetricObserver, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';

let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
async function main() {
  const samples: Array<{ phase: string; documents: number; measurement: DocumentOperationMeasurement }> = [];
  await withDocumentReadToolDispatchFixture(async fixture => {
    const { GET } = await import('../app/api/markdown/link-index/route');
    const { documentLinkReadProjectionStatistics, withFreshDocumentLinkReadProjection } =
      await import('../app/lib/markdown/document-link-read-projection');
    const { createPlainTextYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const credential = (await fixture.admin.query('SELECT token FROM "session" WHERE id=$1 AND user_id=$2',
      ['reader-session', 'reader'])).rows[0]?.token;
    assert.equal(typeof credential, 'string');
    const cookie = (await serializeSignedCookie('better-auth.session_token', credential, process.env.BETTER_AUTH_SECRET!)).split(';')[0];
    const request = () => new NextRequest('http://localhost/api/markdown/link-index', {
      headers: { cookie, 'x-canvas-workspace-id': fixture.workspaceId },
    });
    const read = async (phase: string, documents: number, fresh = false) => {
      let observed: DocumentOperationMeasurement | undefined;
      const execute = () => withDocumentOperationMetricObserver(value => { assert.equal(observed, undefined); observed = value; },
        () => measureDocumentOperation('links', 'request', () => GET(request())));
      const response = await (fresh ? withFreshDocumentLinkReadProjection(execute) : execute());
      assert.equal(response.status, 200);
      const body = await response.json(); assert(body.index);
      const { generatedAt, ...semantic } = body.index;
      assert.equal(typeof generatedAt, 'string'); assert.equal(semantic.documents.length, documents);
      assert.equal(semantic.diagnostics.sourcesComplete, true);
      assert(observed); assert.equal(observed.unsupportedQueryForms, 0);
      assert.equal(observed.openQueriesAtCompletion, 0); assert.equal(observed.openConnectionsAtCompletion, 0);
      samples.push({ phase, documents, measurement: observed });
      return semantic;
    };
    let first: Awaited<ReturnType<typeof fixture.seed>> | undefined;
    for (let index = 0; index < 200; index++) {
      const target = await fixture.seed({ filePath: `bench/source-${index}.md`, text: `# Source ${index}\n\n[[missing-target]]` });
      first ??= target;
      if (index !== 9 && index !== 199) continue;
      const count = index + 1, before = documentLinkReadProjectionStatistics(), snapshot = await fixture.snapshot();
      const cold = await read('cold', count), afterCold = documentLinkReadProjectionStatistics();
      assert.equal(afterCold.inspections - before.inspections, count === 10 ? 10 : 190);
      assert.deepEqual(await read('warm', count), cold);
      assert.equal(documentLinkReadProjectionStatistics().inspections, afterCold.inspections);
      assert.deepEqual(await read('full-rebuild', count, true), cold);
      assert.equal(documentLinkReadProjectionStatistics().inspections - afterCold.inspections, count * 2);
      assert.deepEqual(await fixture.snapshot(), snapshot, 'Cold, warm and full rebuild reads do not alter native state or identity.');
    }
    assert(first);
    const changed = createPlainTextYDoc('# Changed\n\n[[missing-target]]\n[Relative](../external.md)');
    try {
      await fixture.admin.query(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,
        document_sequence=document_sequence+1,persisted_at=$3 WHERE document_id=$4`,
      [Buffer.from(Y.encodeStateAsUpdate(changed)), Buffer.from(Y.encodeStateVector(changed)), Date.now(), first.documentId]);
    } finally { changed.destroy(); }
    const beforeDirty = documentLinkReadProjectionStatistics(), dirty = await read('single-document-change', 200);
    assert.equal(documentLinkReadProjectionStatistics().inspections - beforeDirty.inspections, 1);
    assert.deepEqual(await read('dirty-full-rebuild', 200, true), dirty);
    await fixture.seed({ filePath: 'targets/missing-target.md', text: '# Missing target now exists\n' });
    const beforeTarget = documentLinkReadProjectionStatistics(), resolved = await read('new-target', 201);
    assert.equal(documentLinkReadProjectionStatistics().inspections - beforeTarget.inspections, 1);
    assert.equal(resolved.edges.filter((edge: { targetPath: string }) => edge.targetPath === 'targets/missing-target.md').length, 200);
    await writeFile(path.join(fixture.workspaceRoot, 'external.md'), '# External physical source\n\n[[missing-target]]');
    const withPhysical = await read('external-physical-change', 202);
    assert(withPhysical.documents.some((document: { path: string }) => document.path === 'external.md'));
    assert.deepEqual(await read('physical-full-rebuild', 202, true), withPhysical);
    await fixture.admin.query(`UPDATE organization_user_permissions SET status='disabled'
      WHERE organization_id='tool-dispatch-org' AND user_id='reader'`);
    // The actual auth hook invalidates this disabled member's session; the
    // route's existing authentication contract therefore returns 401.
    const denied = await GET(request()); assert.equal(denied.status, 401);
    const deniedBody = await denied.json(); assert.equal(Object.hasOwn(deniedBody, 'index'), false);
    console.log(JSON.stringify({ suite: 'document-link-index-route-postgres',
      actualCookieRoute: true, sizes: [10, 200], singleDirtyInspection: 1,
      freshRebuildParity: true, newTargetResolved: true, physicalChangesObserved: true, revokedAccessDenied: true }));
  });
  const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT;
  assert(output && path.isAbsolute(output));
  await writeFile(output, JSON.stringify({ version: 1, fixture: 'actual-document-index-route', samples }, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' });
  completed = true;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
