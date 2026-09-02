import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { closeDatabaseConnections } from '@/app/lib/db';
import { createPostgresPool, runPostgresMigrations } from '@/app/lib/db/postgres';
import {
  applyExcalidrawScenePatch,
  archiveExcalidrawScenePaths,
  ensureExcalidrawScene,
  ExcalidrawSceneResyncError,
  loadExcalidrawScene,
  moveExcalidrawScenePaths,
  reactivateExcalidrawScenePath,
} from '@/app/lib/excalidraw-collaboration/repository';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';

function element(id: string, version: number, versionNonce: number, overrides: Record<string, unknown> = {}): ExcalidrawElementRecord {
  return {
    id,
    type: 'rectangle',
    version,
    versionNonce,
    isDeleted: false,
    index: `a${id}`,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    angle: 0,
    opacity: 100,
    groupIds: [],
    boundElements: [],
    ...overrides,
  };
}

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres', 'This integration test requires a native Postgres test database.');
  const migrationPool = createPostgresPool();
  await runPostgresMigrations(migrationPool);
  await migrationPool.end();

  const suffix = `${Date.now()}-${process.pid}`;
  const documentId = `excal-live-${suffix}`;
  const nestedDocumentId = `excal-live-nested-${suffix}`;
  const wildcardSiblingDocumentId = `excal-live-wildcard-sibling-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  let state = await ensureExcalidrawScene({
    documentId,
    workspaceId,
    organizationId: `org-${suffix}`,
    path: 'drawings/team.excalidraw',
    initialContent: JSON.stringify({
      type: 'excalidraw',
      elements: [
        element('shared', 1, 900),
        element('box', 1, 800, { groupIds: ['group-a'], boundElements: [{ id: 'label', type: 'text' }] }),
        element('label', 1, 700, { type: 'text', containerId: 'box' }),
        element('frame', 1, 600, { type: 'frame' }),
        element('arrow', 1, 500, { type: 'arrow', startBinding: { elementId: 'box' }, endBinding: { elementId: 'frame' } }),
      ],
      appState: { viewBackgroundColor: '#ffffff' },
    }),
  });
  assert.equal(state.sceneSequence, 0);

  const clientA = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 0,
    messageId: `client-a-${suffix}`,
    elements: [element('only-a', 1, 100, { index: 'a100' })],
    actorType: 'user',
    actorId: 'user-a',
  });
  const clientB = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 0,
    messageId: `client-b-${suffix}`,
    elements: [element('only-b', 1, 101, { index: 'a101' })],
    actorType: 'user',
    actorId: 'user-b',
  });
  assert.equal(clientA.state.sceneSequence, 1);
  assert.equal(clientB.state.sceneSequence, 2, 'Different-element offline patches must rebase and converge.');

  const sameA = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 2,
    messageId: `same-a-${suffix}`,
    elements: [element('shared', 2, 700, { x: 70 })],
    actorType: 'user',
    actorId: 'user-a',
  });
  const sameB = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 2,
    messageId: `same-b-${suffix}`,
    elements: [element('shared', 2, 300, { x: 30 })],
    actorType: 'user',
    actorId: 'user-b',
  });
  assert.equal(sameA.state.sceneSequence, 3);
  assert.equal(sameB.state.elements.find((candidate) => candidate.id === 'shared')?.x, 30, 'Lower same-version nonce must win deterministically.');

  const duplicate = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: 2,
    messageId: `same-b-${suffix}`,
    elements: [element('shared', 2, 300, { x: 30 })],
    actorType: 'user',
    actorId: 'user-b',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.sceneSequence, sameB.state.sceneSequence);

  const tombstone = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: sameB.state.sceneSequence,
    messageId: `delete-${suffix}`,
    elements: [element('only-a', 2, 99, { isDeleted: true })],
    actorType: 'user',
    actorId: 'user-a',
  });
  const staleResurrection = await applyExcalidrawScenePatch({
    documentId,
    lifecycleGeneration: 1,
    baseSequence: tombstone.state.sceneSequence,
    messageId: `stale-${suffix}`,
    elements: [element('only-a', 1, 1)],
    actorType: 'user',
    actorId: 'offline-user',
  });
  assert.equal(staleResurrection.state.elements.find((candidate) => candidate.id === 'only-a')?.isDeleted, true);

  await assert.rejects(
    applyExcalidrawScenePatch({
      documentId,
      lifecycleGeneration: 1,
      baseSequence: -3_000,
      messageId: `too-stale-${suffix}`,
      elements: [element('never', 1, 1)],
      actorType: 'user',
      actorId: 'offline-user',
    }),
    ExcalidrawSceneResyncError,
  );

  const latencies: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    state = (await loadExcalidrawScene(documentId))!;
    const started = performance.now();
    await applyExcalidrawScenePatch({
      documentId,
      lifecycleGeneration: 1,
      baseSequence: state.sceneSequence,
      messageId: `latency-${suffix}-${index}`,
      elements: [element(`latency-${index}`, 1, index + 1, { index: `z${String(index).padStart(3, '0')}` })],
      actorType: 'user',
      actorId: 'perf-user',
    });
    latencies.push(performance.now() - started);
  }
  latencies.sort((left, right) => left - right);
  const p95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1];
  assert.ok(p95Ms < 250, `Postgres scene apply p95 exceeded 250 ms (${p95Ms.toFixed(1)} ms).`);

  await moveExcalidrawScenePaths({ workspaceId, oldPath: 'drawings/team.excalidraw', newPath: 'drawings/renamed.excalidraw' });
  assert.equal((await loadExcalidrawScene(documentId))?.path, 'drawings/renamed.excalidraw');

  await ensureExcalidrawScene({
    documentId: nestedDocumentId,
    workspaceId,
    organizationId: `org-${suffix}`,
    path: 'drawings/set_1/hi.excalidraw',
    initialContent: JSON.stringify({ type: 'excalidraw', elements: [], appState: {} }),
  });
  await ensureExcalidrawScene({
    documentId: wildcardSiblingDocumentId,
    workspaceId,
    organizationId: `org-${suffix}`,
    path: 'drawings/setX1/untouched.excalidraw',
    initialContent: JSON.stringify({ type: 'excalidraw', elements: [], appState: {} }),
  });
  await moveExcalidrawScenePaths({
    workspaceId,
    oldPath: 'drawings/set_1',
    newPath: 'drawings/renamed-set',
  });
  assert.equal(
    (await loadExcalidrawScene(nestedDocumentId))?.path,
    'drawings/renamed-set/hi.excalidraw',
    'Moving a folder must preserve the nested relative Excalidraw path.',
  );
  assert.equal(
    (await loadExcalidrawScene(wildcardSiblingDocumentId))?.path,
    'drawings/setX1/untouched.excalidraw',
    'SQL wildcard characters in a folder name must not match sibling paths.',
  );
  await archiveExcalidrawScenePaths({ workspaceId, paths: ['drawings/renamed.excalidraw'] });
  assert.equal(await loadExcalidrawScene(documentId), null);
  const archived = await loadExcalidrawScene(documentId, true);
  assert.equal(archived?.status, 'archived');
  await reactivateExcalidrawScenePath({ workspaceId, path: 'drawings/renamed.excalidraw' });
  assert.equal((await loadExcalidrawScene(documentId))?.lifecycleGeneration, 3);

  console.log(JSON.stringify({ success: true, clients: 2, sceneSequence: state.sceneSequence, postgresApplyP95Ms: Number(p95Ms.toFixed(1)) }));
}

void main().finally(closeDatabaseConnections);
