import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import {
  canonicalSceneHash,
  mergeExcalidrawElements,
  sharedExcalidrawAppState,
  validateExcalidrawElements,
} from '@/app/lib/excalidraw-collaboration/scene';
import type { ExcalidrawElementRecord } from '@/app/lib/excalidraw-collaboration/protocol';

function element(
  id: string,
  version: number,
  versionNonce: number,
  overrides: Record<string, unknown> = {},
): ExcalidrawElementRecord {
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
  const packageJson = JSON.parse(await readFile('node_modules/@excalidraw/excalidraw/package.json', 'utf8')) as { version?: string };
  assert.equal(packageJson.version, '0.18.1', 'Task 52 must be revalidated when Excalidraw changes.');
  const publicTypes = await readFile('node_modules/@excalidraw/excalidraw/dist/types/excalidraw/index.d.ts', 'utf8');
  const propsTypes = await readFile('node_modules/@excalidraw/excalidraw/dist/types/excalidraw/types.d.ts', 'utf8');
  assert.match(publicTypes, /reconcileElements/u);
  assert.match(publicTypes, /CaptureUpdateAction/u);
  assert.match(propsTypes, /onPointerUpdate/u);
  assert.match(propsTypes, /collaborators/u);
  assert.match(propsTypes, /getSceneElementsIncludingDeleted/u);
  assert.match(propsTypes, /addFiles/u);

  const shared = element('shared', 2, 700);
  const clientA = [shared, element('only-a', 1, 10, { groupIds: ['group-1'] })];
  const clientB = [
    element('shared', 2, 500, { x: 25 }),
    element('only-b', 1, 20, { type: 'frame' }),
  ];
  const first = mergeExcalidrawElements(validateExcalidrawElements(clientA, 'patch'), validateExcalidrawElements(clientB, 'patch'));
  const second = mergeExcalidrawElements(validateExcalidrawElements(clientB, 'patch'), validateExcalidrawElements(clientA, 'patch'));
  assert.equal(first.elements.find((candidate) => candidate.id === 'shared')?.versionNonce, 500);
  assert.equal(second.elements.find((candidate) => candidate.id === 'shared')?.versionNonce, 500);
  assert.deepEqual(new Set(first.elements.map((candidate) => candidate.id)), new Set(['shared', 'only-a', 'only-b']));
  assert.equal(canonicalSceneHash({ elements: first.elements, appState: {} }), canonicalSceneHash({ elements: second.elements, appState: {} }));

  const deleted = mergeExcalidrawElements(first.elements, [element('only-a', 2, 9, { isDeleted: true })]);
  assert.equal(deleted.elements.find((candidate) => candidate.id === 'only-a')?.isDeleted, true);
  const staleOffline = mergeExcalidrawElements(deleted.elements, [element('only-a', 1, 1)]);
  assert.equal(staleOffline.elements.find((candidate) => candidate.id === 'only-a')?.isDeleted, true, 'A stale offline client must not resurrect a tombstone.');

  const structure = validateExcalidrawElements([
    element('box', 1, 1, { groupIds: ['group-1'], boundElements: [{ id: 'label', type: 'text' }] }),
    element('label', 1, 2, { type: 'text', containerId: 'box' }),
    element('arrow', 1, 3, { type: 'arrow', startBinding: { elementId: 'box' }, endBinding: { elementId: 'frame' } }),
    element('frame', 1, 4, { type: 'frame' }),
  ], 'scene');
  assert.equal(structure.length, 4);
  assert.deepEqual(sharedExcalidrawAppState({
    viewBackgroundColor: '#fff',
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: true,
    selectedElementIds: { box: true },
    zoom: { value: 2 },
  }), {
    viewBackgroundColor: '#fff',
    gridSize: 20,
    gridStep: 5,
    gridModeEnabled: true,
  });

  const large = Array.from({ length: 20_000 }, (_, index) => element(`large-${index}`, 1, index, { index: `a${String(index).padStart(6, '0')}` }));
  const started = performance.now();
  const validatedLarge = validateExcalidrawElements(large, 'scene');
  const mergedLarge = mergeExcalidrawElements(validatedLarge, [element('large-19999', 2, 1, { x: 42, index: 'a019999' })]);
  const durationMs = performance.now() - started;
  assert.equal(mergedLarge.elements.length, 20_000);
  assert.ok(durationMs < 1_500, `Large scene validation/reconciliation took ${durationMs.toFixed(1)} ms.`);

  console.log(JSON.stringify({
    success: true,
    excalidrawVersion: packageJson.version,
    provider: 'canvas_native_excalidraw_scene_provider',
    forkRequired: false,
    largeSceneElements: large.length,
    largeSceneMergeMs: Number(durationMs.toFixed(1)),
  }, null, 2));
}

void main();
