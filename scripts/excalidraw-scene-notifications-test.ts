import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { PoolClient } from 'pg';
import { installExcalidrawSceneNotificationListener, EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL } from '@/app/lib/excalidraw-collaboration/runtime';
import type { PersistedExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

class ListenerClient extends EventEmitter {
  statements: string[] = [];
  releases = 0;
  async query(sql: string) { this.statements.push(sql); return { rows: [] }; }
  release() { this.releases += 1; assert.equal(this.releases, 1, 'A disconnected pool client may only be discarded once.'); }
  hint(payload: unknown) {
    this.emit('notification', { channel: EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL, payload: JSON.stringify(payload) });
  }
}

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('Notification delivery did not reach the expected durable state.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function main() {
  const clients: ListenerClient[] = [];
  const delivered: Array<{ generation: number; sequence: number; elements: string[] }> = [];
  const identities: Array<{ path: string; status: string }> = [];
  const failures: unknown[] = [];
  let reconnects = 0;
  let state: PersistedExcalidrawScene = {
    documentId: 'notification-document', workspaceId: 'notification-workspace', organizationId: null,
    path: 'drawing.excalidraw', lifecycleGeneration: 1, excalidrawVersion: '0.18.1', sceneSchemaVersion: 1,
    elements: [], appState: {}, assets: [], sceneSequence: 0, checkpointSequence: 0,
    checkpointRevisionId: null, checkpointContentHash: null, canonicalHash: 'initial',
    persistedAt: 1, checkpointedAt: null, degradedReason: null, status: 'active',
  };
  const listener = installExcalidrawSceneNotificationListener({
    documentIds: () => ['notification-document'], retryMs: 5,
    connect: async () => { const client = new ListenerClient(); clients.push(client); return client as unknown as PoolClient; },
    loadScene: async () => structuredClone(state),
    onScene: value => { delivered.push({ generation: value.lifecycleGeneration, sequence: value.sceneSequence,
      elements: value.elements.map(element => element.id) }); identities.push({ path: value.path, status: value.status }); },
    onReconnect: () => { reconnects += 1; }, onError: error => { failures.push(error); },
  });
  try {
    await listener.ready;
    assert.deepEqual(clients[0].statements, [`LISTEN ${EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL}`]);
    assert.deepEqual(delivered, [{ generation: 1, sequence: 0, elements: [] }]);
    clients[0].hint({ documentId: state.documentId, sceneSequence: 0, elements: [{ id: 'untrusted' }] });
    clients[0].hint({ documentId: '../foreign', sceneSequence: 1 });
    clients[0].hint({ documentId: state.documentId, sceneSequence: -1 });
    await listener.resync();
    assert.equal(delivered.length, 2, 'Only the explicit resync may redeliver an unchanged scene.');

    // A notification can lag the authoritative DB; delivery must include every missing element.
    state = { ...state, sceneSequence: 3, elements: [
      { id: 'persisted-a', type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false },
      { id: 'persisted-b', type: 'ellipse', version: 1, versionNonce: 20, isDeleted: false },
    ] };
    clients[0].hint({ documentId: state.documentId, sceneSequence: 1, elements: [{ id: 'untrusted' }] });
    await waitUntil(() => delivered.length === 3);
    assert.deepEqual(delivered.at(-1), { generation: 1, sequence: 3, elements: ['persisted-a', 'persisted-b'] });
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    clients[0].hint({ documentId: state.documentId, sceneSequence: 2 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(delivered.length, 3, 'Duplicate and reordered notifications must not redeliver the same generation.');

    state = { ...state, lifecycleGeneration: 2 };
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    await waitUntil(() => delivered.length === 4);
    assert.equal(delivered.at(-1)?.generation, 2, 'A lifecycle change must be delivered even at the same sequence.');

    state = { ...state, path: 'renamed.excalidraw' };
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    await waitUntil(() => delivered.length === 5);
    assert.equal(identities.at(-1)?.path, state.path, 'Rename invalidates old path tickets even without a new scene sequence.');
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(delivered.length, 5, 'Duplicate rename notifications are deduplicated.');
    state = { ...state, status: 'archived' };
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    await waitUntil(() => delivered.length === 6);
    assert.equal(identities.at(-1)?.status, 'archived', 'An archived identity is delivered even at equal generation and sequence.');
    state = { ...state, status: 'active' };
    clients[0].hint({ documentId: state.documentId, sceneSequence: 3 });
    await waitUntil(() => delivered.length === 7);

    state = { ...state, sceneSequence: 8 };
    clients[0].emit('error', new Error('Simulated transport disconnect'));
    clients[0].emit('end');
    await waitUntil(() => reconnects === 2);
    assert.equal(clients[0].releases, 1);
    assert.equal(delivered.at(-1)?.sequence, 8, 'Reconnect must recover durable changes missed while LISTEN was disconnected.');
    assert.equal(failures.length, 1);
  } finally { await listener.stop(); }
  assert.equal(clients.at(-1)?.releases, 1);
  const count = delivered.length;
  clients.at(-1)?.hint({ documentId: state.documentId, sceneSequence: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(delivered.length, count, 'Stopped listeners cannot broadcast.');
  console.log('Excalidraw notification gaps, duplicates, rename, lifecycle changes and reconnect recovery verified.');
}

void main();
