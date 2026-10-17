import assert from 'node:assert/strict';
import type { AppliedExcalidrawPatch, PersistedExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { prepareExcalidrawAppliedDelivery } from '@/server/excalidraw-collaboration/applied-delivery';

const initial: PersistedExcalidrawScene = {
  documentId: 'broadcast-document', workspaceId: 'broadcast-workspace', organizationId: null,
  path: 'drawing.excalidraw', lifecycleGeneration: 1, excalidrawVersion: '0.18.1', sceneSchemaVersion: 1,
  elements: [], appState: {}, assets: [], sceneSequence: 1, checkpointSequence: 1,
  checkpointRevisionId: 'initial-revision', checkpointContentHash: 'initial-file-hash', canonicalHash: 'initial-scene-hash',
  persistedAt: 1, checkpointedAt: 1, degradedReason: null, status: 'active',
};
const remoteElement = { id: 'remote-deletion', type: 'rectangle', version: 2, versionNonce: 20, isDeleted: true };
const localElement = { id: 'local-edit', type: 'ellipse', version: 2, versionNonce: 30, isDeleted: false };
const remoteAsset = { fileId: 'remote-asset', mimeType: 'image/png', sizeBytes: 100, createdAt: 42,
  version: 1, contentHash: '0'.repeat(64) };
const remoteState = { ...initial, sceneSequence: 2, elements: [remoteElement],
  appState: { viewBackgroundColor: '#123456' }, assets: [remoteAsset], canonicalHash: 'remote-hash' };
const localState = { ...remoteState, sceneSequence: 3, elements: [remoteElement, localElement],
  appState: { ...remoteState.appState, gridModeEnabled: true }, canonicalHash: 'local-hash' };
const localResult: AppliedExcalidrawPatch = { state: localState, acceptedElements: [localElement],
  acceptedAppState: { gridModeEnabled: true }, duplicate: false };

// The remote commit is durable but its PostgreSQL notification is still queued
// when either the agent bridge or a browser patch commits another element.
const localDelivery = prepareExcalidrawAppliedDelivery({ result: localResult, broadcastSequence: initial.sceneSequence,
  broadcastState: initial, replyTo: 'local-operation', messageId: 'local-delivery' });
assert(localDelivery.broadcast);
assert.deepEqual(localDelivery.message.elements, [remoteElement, localElement], 'Advancing over a missed sequence must include remote edits and tombstones.');
assert.deepEqual(localDelivery.message.appState, localState.appState, 'A local update cannot hide the missed remote app state.');
assert.deepEqual(localDelivery.message.assets, [remoteAsset]);
assert.equal(localDelivery.message.canonicalHash, 'local-hash');

// A delayed remote callback cannot rebroadcast older state after that gap was
// closed. A duplicate browser request receives only the latest durable reply.
const delayed = prepareExcalidrawAppliedDelivery({ result: { state: remoteState, acceptedElements: [remoteElement],
  acceptedAppState: remoteState.appState, duplicate: false }, broadcastSequence: localDelivery.state.sceneSequence,
  broadcastState: localDelivery.state, replyTo: 'delayed-remote', messageId: 'delayed-delivery' });
assert.equal(delayed.broadcast, false);
assert.equal(delayed.message.sceneSequence, 3);
assert.deepEqual(delayed.message.elements, localState.elements);
assert.deepEqual(delayed.message.appState, localState.appState);
const duplicate = prepareExcalidrawAppliedDelivery({ result: { ...localResult, duplicate: true, state: initial },
  broadcastSequence: 3, broadcastState: localState, replyTo: 'duplicate-operation', messageId: 'duplicate-delivery' });
assert.equal(duplicate.broadcast, false);
assert.equal(duplicate.message.replyTo, 'duplicate-operation');
assert.equal(duplicate.message.sceneSequence, 3, 'An old idempotent response must not roll back the acknowledged scene.');
assert.deepEqual(duplicate.message.assets, [remoteAsset]);

const contiguous = prepareExcalidrawAppliedDelivery({ result: { ...localResult, state: { ...localState, sceneSequence: 4 } },
  broadcastSequence: 3, broadcastState: localState, replyTo: 'next-operation', messageId: 'next-delivery' });
assert(contiguous.broadcast);
assert.deepEqual(contiguous.message.elements, [localElement]);
assert.deepEqual(contiguous.message.appState, { gridModeEnabled: true });
console.log('Excalidraw local broadcasts close queued cross-process gaps and preserve monotonic idempotent replies.');
