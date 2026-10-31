import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { measureDocumentDatabaseActivity, measureDocumentOperation, withDocumentOperationMetricObserver,
  type DocumentDatabaseActivityMeasurement, type DocumentOperationMeasurement } from '../app/lib/observability/document-operation-metrics';
import { withNativeCopyMetadataOwnerFixture } from './helpers/native-copy-metadata-owner-fixture';
import { documentBaselineSize, fillDocumentBaselineFixture } from './helpers/document-baseline-fixture';

assert.equal(process.env.NODE_ENV, 'test');
const output = process.env.CANVAS_DOCUMENT_OPERATION_BASELINE_OUTPUT; assert(output && path.isAbsolute(output));
const desiredSourceCount = documentBaselineSize(process.env.CANVAS_DOCUMENT_BASELINE_DOCUMENTS, 3);
const configuredFamily = process.env.CANVAS_DOCUMENT_PATH_BASELINE_FAMILY;
assert(configuredFamily === undefined || configuredFamily === 'rename' || configuredFamily === 'move');
const family: 'rename' | 'move' | undefined = configuredFamily;
const seedMode = 'normal-upload';
assert.equal(process.env.CANVAS_DOCUMENT_PATH_DIAGNOSTIC_CLONES, undefined, 'Acceptance requires normal uploads and their actual projection receipts.');
let fixtureSourceCount = 0;
const measurements: Array<{ label: string; value: DocumentDatabaseActivityMeasurement }> = [];
const operations: DocumentOperationMeasurement[] = [];
type StageTiming = { label: string; previewMs: number; initialApplyMs: number; completionMs: number;
  projectionMs: number; jobCompleteMs: number; totalMs: number; preparationResponses: number; statusPolls: number };
const stageTimings: StageTiming[] = [];
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
process.once('uncaughtExceptionMonitor', () => {
  try { writeFileSync(output, JSON.stringify({ version: 4, passed: false, fixture: 'public-document-path-operations',
    family: family ?? 'rename-then-move', nativeDocuments: fixtureSourceCount, seedMode, normalUploadAcceptance: false,
    measurements, operations, stageTimings }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch { /* Preserve the original test failure and exit status. */ }
});

await withDocumentOperationMetricObserver(value => operations.push(value), () => withNativeCopyMetadataOwnerFixture(async h => {
  // Real cookie route handlers and their actual native Move owner. Only setup
  // is an isolated SQL QA fixture; there is no invented invocation or policy.
  const { POST: rename } = await import('../app/api/files/rename/route');
  const { POST: mobileMove } = await import('../app/api/mobile/v1/files/move/route');
  const resume = await import('../app/api/files/operations/implicit-moves/[requestId]/route');
  const batch = await import('../app/api/files/operations/batches/[batchId]/route');
  const { readWorkspaceImplicitMovePreparation, readWorkspaceImplicitMoveBinding } = await import('../app/lib/files/workspace-implicit-move-parser');
  const { readWorkspacePathOperation } = await import('../app/lib/files/workspace-path-operation-parser');
  const { readPiRuntimeConfig } = await import('../app/lib/agents/storage');
  const { readDocumentReviewAvailability } = await import('../app/lib/document-review-availability');
  const { WORKSPACE_FILE_UNDO_ENABLED } = await import('../app/lib/files/workspace-file-undo-policy');
  const { createWorkspaceOperationBatchWorker } = await import('../app/lib/files/workspace-operation-batch-worker');
  const { Y } = await import('../app/lib/collaboration/server-runtime');
  const { richMarkdownFromYDoc } = await import('../app/lib/collaboration/markdown-state');
  const { createCollaborationServer } = await import('../server/collaboration-server');
  const { createCollaborationRoomOwnerOptions } = await import('../app/lib/collaboration/room-owner-options');
  const { listPendingCollaborationProjections, readCollaborationProjectionHealth } = await import('../app/lib/collaboration/projection-repository');
  const { withWorkspaceMutationLock } = await import('../app/lib/files/workspace-mutation-lock');
  const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
  await readPiRuntimeConfig(); assert.equal(readDocumentReviewAvailability().documentReviewEnabled, false);
  assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);
  const targetText = '# Native target\n\n[Other](source.md)\n\nKeep all content 😀.\n';
  const incomingText = '# Incoming\n\n[Target](target.md)\n';
  const target = await h.upload('folder/target.md', Buffer.from(targetText));
  const incoming = await h.upload('folder/source.md', Buffer.from(incomingText));
  fixtureSourceCount = await fillDocumentBaselineFixture({ target: desiredSourceCount,
    count: async () => Number((await h.admin.query("SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND status='active'",
      [h.source.workspaceId])).rows[0].n),
    seed: async index => {
      const file = { path: `unrelated/extra-${index}.md`, content: `# Unrelated fixture ${index}\n\nKept content.\n` };
      await h.upload(file.path, Buffer.from(file.content));
    },
  });
  const unrelatedFiles = (await h.admin.query(`SELECT id,path FROM collaboration_documents
    WHERE workspace_id=$1 AND status='active' AND id<>ALL($2::text[]) ORDER BY id`,
  [h.source.workspaceId, [target.documentId, incoming.documentId]])).rows as Array<{ id: string; path: string }>;
  assert.equal(unrelatedFiles.length, fixtureSourceCount - 2);
  const unrelatedPhysical = new Map<string, string>();
  const readUnrelatedRows = async () => (await h.admin.query(`
    SELECT to_jsonb(d) AS registry,d.xmin::text AS registry_xmin,to_jsonb(l) AS lineage,l.xmin::text AS lineage_xmin,
      to_jsonb(s) AS native,s.xmin::text AS native_xmin,to_jsonb(m) AS metadata,m.xmin::text AS metadata_xmin
    FROM collaboration_documents d JOIN file_collaboration_lineages l ON l.id=d.lineage_id
      JOIN collaboration_yjs_states s ON s.document_id=d.id
      LEFT JOIN workspace_file_metadata m ON m.workspace_id=d.workspace_id AND m.path=d.path
    WHERE d.workspace_id=$1 AND d.id=ANY($2::text[]) ORDER BY d.id`,
  [h.source.workspaceId, unrelatedFiles.map(file => file.id)])).rows;
  const fingerprint = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const authenticated = await h.request(h.source, 'owner', true);
  const request = (url: string, method: 'GET' | 'POST', body?: object) => new NextRequest(`http://localhost${url}`, {
    method, headers: new Headers({ ...Object.fromEntries(authenticated.headers), 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const readNative = async (documentId: string) => {
    const row = (await h.admin.query(`SELECT d.lineage_id,d.status AS registry_status,s.* FROM collaboration_documents d
      JOIN collaboration_yjs_states s ON s.document_id=d.id WHERE d.id=$1 AND d.workspace_id=$2`,
    [documentId, h.source.workspaceId])).rows[0]; assert(row);
    const doc = new Y.Doc();
    try { Y.applyUpdate(doc, new Uint8Array(row.yjs_state)); return { path: String(row.path), lineageId: String(row.lineage_id),
      lifecycleGeneration: Number(row.lifecycle_generation), sequence: Number(row.document_sequence),
      checkpointSequence: Number(row.checkpoint_sequence), checkpointed: row.checkpointed_at !== null,
      status: row.status, registryStatus: row.registry_status,
      text: row.representation === 'plain_text' ? doc.getText('content').toString() : richMarkdownFromYDoc(doc) }; }
    finally { doc.destroy(); }
  };
  const run = async (label: string, action: 'rename' | 'move', oldPath: string, newPath: string,
    invoke: typeof rename): Promise<{ operationId: string; body: Record<string, unknown> }> => {
    const operationId = randomUUID();
    return measureDocumentDatabaseActivity(action, 'request', () => measureDocumentOperation(action, 'request', async () => {
      const startedAt = performance.now();
      const previewResponse = await invoke(request('/api/files/rename', 'POST', { oldPath, newPath, dryRun: true }));
      const preview = await previewResponse.json(); assert.equal(previewResponse.status, 200, `Public preview failed: ${preview.code ?? 'unknown'}`);
      assert.equal(preview.plan.kind, 'native-path-change'); assert.equal(preview.plan.readiness, 'ready');
      assert.equal(preview.plan.linkAssessment.complete, true);
      const previewAt = performance.now();
      let response = await invoke(request(action === 'move' ? '/api/mobile/v1/files/move' : '/api/files/rename', 'POST',
        { oldPath, newPath, idempotencyKey: operationId }));
      const initialApplyAt = performance.now();
      let preparationResponses = 0, statusPolls = 0;
      let pinned: ReturnType<typeof readWorkspacePathOperation> | undefined;
      let pinnedBinding: ReturnType<typeof readWorkspaceImplicitMoveBinding> | undefined;
      const deadline = Date.now() + 60_000;
      while (true) {
        const body = await response.json() as Record<string, unknown>;
        assert([200, 202].includes(response.status) && body.success === true,
          `Public file action failed: ${String(body.code ?? 'unknown')} (${response.status})`);
        if (body.preparation) {
          preparationResponses++;
          const preparation = readWorkspaceImplicitMovePreparation(body.preparation, { actorUserId: 'owner',
            workspaceId: h.source.workspaceId, operationId, action: 'rename',
            selections: [{ sourcePath: oldPath, destinationPath: newPath }] });
          assert(preparation.state === 'pending' && preparation.canResume, 'The original preparation cannot safely resume.');
          assert(Date.now() < deadline, 'The public preparation did not finish.');
          await new Promise(done => setTimeout(done, 500));
          response = await resume.POST(request(preparation.resumeUrl, 'POST', {}), { params: Promise.resolve({ requestId: preparation.requestId }) });
          continue;
        }
        const operation = readWorkspacePathOperation(body.operation, pinned ?? { workspaceId: h.source.workspaceId });
        assert.equal(operation.kind, 'rename');
        assert.deepEqual(operation.selections, [{ sourcePath: oldPath, destinationPath: newPath }]);
        if (!pinned) {
          pinnedBinding = readWorkspaceImplicitMoveBinding(operation.implicitBinding,
            { actorUserId: 'owner', workspaceId: h.source.workspaceId, operationId });
          pinned = operation;
        } else if (operation.implicitBinding) readWorkspaceImplicitMoveBinding(operation.implicitBinding, pinnedBinding);
        // The normal status endpoint omits this mapping. Like the existing
        // client, retain only the previously verified immutable binding after
        // checking the exact saved batch/plan/workspace; never invent one.
        if (['queued', 'applying'].includes(operation.status)) {
          assert(Date.now() < deadline, 'The public file action did not finish.');
          await new Promise(done => setTimeout(done, 500));
          statusPolls++;
          response = await batch.GET(request(`/api/files/operations/batches/${operation.batchId}`, 'GET'),
            { params: Promise.resolve({ batchId: operation.batchId }) }); continue;
        }
        assert.equal(operation.status, 'applied', `Public operation stopped: ${operation.errorCode ?? operation.status}`);
        assert.equal(operation.phase, 'complete'); assert.equal(body.linkStatus, 'complete');
        const jobCompleteAt = performance.now();
        // SQL completion confirms native links. The regular projector owns
        // their physical files, so include real convergence in this window.
        const projectionDeadline = Date.now() + 45_000;
        for (;;) {
          let converged = true;
          for (const id of [target.documentId, incoming.documentId]) {
            const state = await readNative(id);
            if (!state.checkpointed || state.sequence !== state.checkpointSequence) converged = false;
            try { if (await fs.readFile(path.join(h.source.rootPath, state.path), 'utf8') !== state.text) converged = false; }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') converged = false; else throw error; }
          }
          if (converged) {
            // This administrative observer uses the actual health predicate,
            // outside the instrumented runtime pool, and cannot authorize work.
            const health = await readCollaborationProjectionHealth(h.connection);
            assert.equal(health.identityConflicts, 0); assert.equal(health.quarantined, 0);
            assert.equal(health.binaryPersistenceFailures, 0); assert.equal(health.inactiveWorkspaceStates, 0);
            if (health.pending === 0) break;
          }
          assert(Date.now() < projectionDeadline, 'The normal durable projector did not materialize native link changes.');
          await new Promise(done => setTimeout(done, 250));
        }
        const projectedAt = performance.now();
        assert(startedAt <= previewAt && previewAt <= initialApplyAt && initialApplyAt <= jobCompleteAt
          && jobCompleteAt <= projectedAt);
        const ms = (duration: number) => Math.round(duration * 100) / 100;
        const timing: StageTiming = { label, previewMs: ms(previewAt - startedAt),
          initialApplyMs: ms(initialApplyAt - previewAt), completionMs: ms(jobCompleteAt - initialApplyAt),
          projectionMs: ms(projectedAt - jobCompleteAt), jobCompleteMs: ms(jobCompleteAt - startedAt),
          totalMs: ms(projectedAt - startedAt), preparationResponses, statusPolls };
        stageTimings.push(timing);
        console.log(JSON.stringify({ publicPathStageTiming: true, ...timing }));
        return { operationId, body };
      }
    }), value => measurements.push({ label, value }));
  };
  // The production custom server owns this worker. A bare HTTP-route fixture
  // must start the real worker too; queued jobs are not self-executing routes.
  // Retain all genuine ticks so cleanup waits for actual claim completion.
  const worker = createWorkspaceOperationBatchWorker(), ticks = new Set<Promise<unknown>>(), workerErrors: unknown[] = [];
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const pendingBeforeRuntime = await listPendingCollaborationProjections('', 500);
  console.log(JSON.stringify({ pathBaselineSetup: true, pendingBeforeRuntime: pendingBeforeRuntime.length,
    pendingUnrelated: unrelatedFiles.filter(file => pendingBeforeRuntime.some(item => item.documentId === file.id)).length,
    pendingStarter: unrelatedFiles.some(file => file.path === WORKSPACE_STARTER_DOCUMENT_NAME
      && pendingBeforeRuntime.some(item => item.documentId === file.id)) }));
  const wss = createCollaborationServer(server, { roomOwner: createCollaborationRoomOwnerOptions() });
  const tick = () => {
    const pending = worker.tick(); ticks.add(pending);
    void pending.catch(error => workerErrors.push(error)).finally(() => ticks.delete(pending));
  };
  const timer = setInterval(tick, 1000); tick();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // Finish genuine startup projection before the immutable action baseline.
    // The real kernel lock waits through the projector's post-checkpoint work;
    // the original unrelated-state comparison is never refreshed after an action.
    const startupDeadline = Date.now() + 45_000;
    let baseline: { rows: Awaited<ReturnType<typeof readUnrelatedRows>>;
      target: Awaited<ReturnType<typeof readNative>>; incoming: Awaited<ReturnType<typeof readNative>> } | null = null;
    while (!baseline) {
      baseline = await withWorkspaceMutationLock(h.source.workspaceId, async () => {
        if ((await listPendingCollaborationProjections('', 500)).length) return null;
        for (const file of unrelatedFiles) unrelatedPhysical.set(file.path,
          createHash('sha256').update(await fs.readFile(path.join(h.source.rootPath, file.path))).digest('hex'));
        return { rows: await readUnrelatedRows(), target: await readNative(target.documentId), incoming: await readNative(incoming.documentId) };
      });
      if (!baseline) { assert(Date.now() < startupDeadline, 'Actual initial projection backlog did not settle.'); await new Promise(done => setTimeout(done, 100)); }
    }
    const originalUnrelatedRows = baseline.rows, originalUnrelatedFingerprint = fingerprint(originalUnrelatedRows);
    assert.equal(originalUnrelatedRows.length, unrelatedFiles.length);
    const initialTarget = baseline.target, initialIncoming = baseline.incoming;
    console.log(JSON.stringify({ pathBaselineSetup: true, startupProjectionSettled: true,
      originalUnrelatedSources: originalUnrelatedRows.length, includesStarter: true }));
    if (family) {
      const alternate = family === 'rename' ? 'folder/renamed.md' : 'destination/target.md';
      const invoke = family === 'rename' ? rename : mobileMove;
      const operationIds = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt++) {
        const restoring = attempt === 1, oldPath = restoring ? alternate : initialTarget.path;
        const newPath = restoring ? initialTarget.path : alternate;
        const applied = await run(`${attempt === 0 ? 'cold' : 'warm'}-public-${family}-preview-through-file-checkpoint`,
          family, oldPath, newPath, invoke);
        assert.equal(operationIds.has(applied.operationId), false); operationIds.add(applied.operationId);
        const actualTarget = await readNative(target.documentId), actualIncoming = await readNative(incoming.documentId);
        for (const [actual, initial] of [[actualTarget, initialTarget], [actualIncoming, initialIncoming]]) {
          assert.equal(actual.lineageId, initial.lineageId); assert.equal(actual.lifecycleGeneration, initial.lifecycleGeneration);
          assert.equal(actual.status, 'active'); assert.equal(actual.registryStatus, 'active');
          assert(actual.sequence >= initial.sequence); assert.equal(actual.checkpointSequence, actual.sequence);
          assert.equal(actual.checkpointed, true);
        }
        assert.equal(actualTarget.path, newPath); assert.equal(actualIncoming.path, initialIncoming.path);
        if (family === 'rename') assert.deepEqual(actualTarget, { ...initialTarget, path: newPath });
        assert.equal(actualTarget.text, restoring || family === 'rename' ? targetText
          : targetText.replace('(source.md)', '(../folder/source.md)'));
        assert.equal(actualIncoming.text, restoring ? incomingText : incomingText.replace('(target.md)',
          family === 'rename' ? '(renamed.md)' : '(../destination/target.md)'));
        assert.equal(await fs.readFile(path.join(h.source.rootPath, newPath), 'utf8'), actualTarget.text);
        assert.equal(await fs.readFile(path.join(h.source.rootPath, initialIncoming.path), 'utf8'), actualIncoming.text);
        await assert.rejects(fs.lstat(path.join(h.source.rootPath, oldPath)), { code: 'ENOENT' });
      }
      assert.equal(operationIds.size, 2);
      assert.equal(await fs.readFile(path.join(h.source.rootPath, initialTarget.path), 'utf8'), targetText);
      assert.equal(await fs.readFile(path.join(h.source.rootPath, initialIncoming.path), 'utf8'), incomingText);
    } else {
      const renamed = await run('public-web-rename-including-preview-and-completion', 'rename', 'folder/target.md', 'folder/renamed.md', rename);
      assert.deepEqual(await readNative(target.documentId), { ...initialTarget, path: 'folder/renamed.md' });
      assert.equal((await readNative(incoming.documentId)).text, incomingText.replace('(target.md)', '(renamed.md)'));
      const moved = await run('public-mobile-move-including-preview-and-completion', 'move', 'folder/renamed.md', 'destination/renamed.md', mobileMove);
      const finalTarget = await readNative(target.documentId), finalIncoming = await readNative(incoming.documentId);
      assert.equal(finalTarget.lineageId, initialTarget.lineageId); assert.equal(finalIncoming.lineageId, initialIncoming.lineageId);
      assert.equal(finalTarget.status, 'active'); assert.equal(finalTarget.registryStatus, 'active');
      assert.equal(finalIncoming.status, 'active'); assert.equal(finalIncoming.registryStatus, 'active');
      assert.equal(finalTarget.path, 'destination/renamed.md');
      assert.equal(finalTarget.text, targetText.replace('(source.md)', '(../folder/source.md)'));
      assert.equal(finalIncoming.text, incomingText.replace('(target.md)', '(../destination/renamed.md)'));
      assert.equal(await fs.readFile(path.join(h.source.rootPath, finalTarget.path), 'utf8'), finalTarget.text);
      assert.equal(await fs.readFile(path.join(h.source.rootPath, finalIncoming.path), 'utf8'), finalIncoming.text);
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'folder/target.md')), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(h.source.rootPath, 'folder/renamed.md')), { code: 'ENOENT' });
      assert.notEqual(renamed.operationId, moved.operationId);
    }
    const finalUnrelatedRows = await readUnrelatedRows(), finalUnrelatedFingerprint = fingerprint(finalUnrelatedRows);
    if (finalUnrelatedFingerprint !== originalUnrelatedFingerprint) {
      const changedFields = new Set<string>(); let affectedRows = 0;
      for (let index = 0; index < Math.max(originalUnrelatedRows.length, finalUnrelatedRows.length); index++) {
        const before = originalUnrelatedRows[index], after = finalUnrelatedRows[index];
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        affectedRows++;
        for (const field of ['registry', 'lineage', 'native', 'metadata', 'registry_xmin', 'lineage_xmin', 'native_xmin', 'metadata_xmin']) {
          if (JSON.stringify(before?.[field]) === JSON.stringify(after?.[field])) continue;
          changedFields.add(field);
          if (!field.endsWith('_xmin')) for (const column of Object.keys({ ...before?.[field], ...after?.[field] })) {
            if (/^[a-z_]+$/u.test(column) && JSON.stringify(before?.[field]?.[column]) !== JSON.stringify(after?.[field]?.[column])) {
              changedFields.add(`${field}.${column}`);
            }
          }
        }
      }
      // Aggregate column names only; no IDs, paths, SQL parameters or contents.
      console.log(JSON.stringify({ unrelatedSourceInvariantFailure: true, seedMode, affectedRows,
        fields: [...changedFields].sort() }));
    }
    assert.equal(finalUnrelatedFingerprint, originalUnrelatedFingerprint,
      'Rename/Move must preserve all unrelated native rows, identities, metadata and xmin.');
    for (const [filePath, expected] of unrelatedPhysical) assert.equal(createHash('sha256')
      .update(await fs.readFile(path.join(h.source.rootPath, filePath))).digest('hex'), expected,
    'An unrelated physical source, including the starter, must remain byte-identical.');
    assert.equal(Number((await h.admin.query("SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND status='active'",
      [h.source.workspaceId])).rows[0].n), fixtureSourceCount);
    console.log(JSON.stringify({ publicPathBaseline: true, reviewCenter: false, fileUndo: false,
      family: family ?? 'rename-then-move', originalPathsRestored: family !== undefined,
      nativeDocuments: fixtureSourceCount, unrelatedSourcesUnchanged: unrelatedFiles.length, includesStarter: true,
      verified: 'actual-cookie-public-handlers-native-owner-and-bidirectional-links',
      measurements: measurements.map(row => ({ label: row.label, statements: row.value.statements, checkouts: row.value.checkouts })) }));
  } finally {
    clearInterval(timer); await Promise.all([...ticks]);
    assert.equal(wss.clients.size, 0, 'This path fixture must retain no transport peers.');
    await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    // Server close disposes future projection scheduling. Wait for existing
    // filesystem callbacks to release their real fences before pool teardown.
    for (const workspaceId of [h.source.workspaceId, h.destination.workspaceId].sort()) {
      await withWorkspaceMutationLock(workspaceId, async () => undefined);
    }
    assert.equal(workerErrors.length, 0);
    console.log(JSON.stringify({ closure: 'document-public-path-runtime', workerDrained: true, serversClosed: true, projectionFencesDrained: true }));
  }
}));
assert.equal(stageTimings.length, measurements.length);
await fs.writeFile(output, JSON.stringify({ version: 4, passed: true, fixture: 'public-document-path-operations', nativeDocuments: fixtureSourceCount,
  family: family ?? 'rename-then-move', originalPathsRestored: family !== undefined,
  unrelatedSourcesUnchanged: fixtureSourceCount - 2, includesStarter: true,
  seedMode, normalUploadAcceptance: true,
  scope: 'actual-cookie-route-handlers-preview-apply-and-terminal-status-no-next-middleware', measurements, operations, stageTimings }, null, 2) + '\n',
{ mode: 0o600, flag: 'wx' });
completed = true;
