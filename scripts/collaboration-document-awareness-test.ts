import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { createDocumentAwarenessLease } from '../app/lib/collaboration/document-awareness';

const doc = new Y.Doc(); const peerDoc = new Y.Doc(); const peer = new Awareness(peerDoc);
try {
  let lease = createDocumentAwarenessLease(doc);
  const observers = () => (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('destroy')?.size;
  const expected = observers();
  let oldNotifications = 0;
  const oldListener = () => { oldNotifications++; };
  for (let index = 0; index < 12; index++) {
    lease.on('update', oldListener);
    lease.setLocalStateField('canvas', { cursor: index });
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(lease, [doc.clientID]), 'network');
    assert.deepEqual(peer.getStates().get(doc.clientID)?.canvas, { cursor: index });
    // Match HocuspocusProvider.destroy: announce removal, then release ownership.
    removeAwarenessStates(lease, [doc.clientID], 'provider destroy');
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(lease, [doc.clientID]), 'network');
    const stale = lease;
    lease.destroy();
    const notifications = oldNotifications;
    lease = createDocumentAwarenessLease(doc);
    lease.setLocalStateField('canvas', { cursor: index + 100 });
    stale.setLocalState(null);
    stale.setLocalStateField('canvas', { cursor: 'stale' });
    assert.equal(oldNotifications, notifications, 'released providers cannot observe new presence');
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(lease, [doc.clientID]), 'network');
    assert.deepEqual(peer.getStates().get(doc.clientID)?.canvas, { cursor: index + 100 }, 'peers immediately accept the new presence clock');
    assert.equal(observers(), expected, 'provider replacement does not accumulate document destroy listeners');
  }
  lease.destroy();
  for (let index = 0; index < 3; index++) {
    const socket = new HocuspocusProviderWebsocket({ url: 'ws://unused.test', autoConnect: false });
    const provider = new HocuspocusProvider({ websocketProvider: socket,
      document: doc, name: 'presence-lifecycle', awareness: createDocumentAwarenessLease(doc) });
    provider.attach();
    provider.setAwarenessField('canvas', { provider: index });
    applyAwarenessUpdate(peer, encodeAwarenessUpdate(provider.awareness!, [doc.clientID]), 'network');
    assert.deepEqual(peer.getStates().get(doc.clientID)?.canvas, { provider: index });
    provider.destroy();
    socket.destroy();
    assert.equal(observers(), expected, 'real provider cleanup retains only the document-owned presence listener');
  }
  console.log('Document-owned awareness keeps monotonic presence and bounded listeners across provider replacements.');
} finally { doc.destroy(); peerDoc.destroy(); }
