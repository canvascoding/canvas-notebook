import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { WorkspaceContext } from '../../app/lib/workspaces/types';
import { fileGuestCookieName } from '../../app/lib/file-guests/types';
import { fileGuestCollaborationSession, fileGuestCheckpoint } from '../../app/lib/file-guests/collaboration';
import type { TextCollaborationRepresentation } from '../../app/lib/collaboration/types';
import { collaborationStateProof } from '../../app/lib/collaboration/state-proof';
import { CollaborationBlockTree } from '../../app/lib/collaboration/block-tree';
import { getSchema } from '@tiptap/core';
import { richMarkdownCodecExtensions } from '../../app/lib/markdown/rich-markdown-codec';
import { fileGuestService } from '../../app/lib/file-guests/service';
import { createCollaborationServer, flushCollaborationDocuments } from '../../server/collaboration-server';
import { listFileGuestVersions, restoreFileGuestVersion } from '../../app/lib/file-guests/versions';

async function until(predicate: () => boolean, message: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Real Hocuspocus messages over loopback; no browser or app/container stack. */
export async function runFileGuestWebsocketScenario(input: {
  workspace: WorkspaceContext;
  path: string;
  representation: TextCollaborationRepresentation;
  participants: Array<{ id: string; token: string }>;
}) {
  const server = http.createServer();
  const websocketServer = createCollaborationServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const peers: Array<{ doc: Y.Doc; provider: HocuspocusProvider; socket: HocuspocusProviderWebsocket; revoked: boolean; rejected: string }> = [];
  const content = (doc: Y.Doc) => {
    if (input.representation === 'plain_text') return doc.getText('content');
    if (input.representation === 'tiptap_xml') return (doc.getXmlFragment('body').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownCodecExtensions()));
    return tree.content(tree.read().child(0).attrs.id).get(0) as Y.XmlText;
  };
  try {
    for (const participant of input.participants) {
      const session = await fileGuestCollaborationSession(participant.id, participant.token);
      assert.equal(session.representation, input.representation);
      class AuthenticatedWebSocket extends WebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols, { headers: { origin: 'http://localhost', cookie: `${fileGuestCookieName(participant.id)}=${participant.token}` } });
        }
      }
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${address.port}/ws/collaboration`, WebSocketPolyfill: AuthenticatedWebSocket });
      const peer = { doc: new Y.Doc(), provider: null as unknown as HocuspocusProvider, socket, revoked: false, rejected: '' };
      peer.provider = new HocuspocusProvider({ websocketProvider: socket,
        name: session.documentId, token: session.token, document: peer.doc,
        onStateless: ({ payload }) => {
          const message = JSON.parse(payload);
          if (message.type === 'access_revoked') peer.revoked = true;
          if (message.type === 'update_rejected') { peer.rejected = message.message; peer.socket.disconnect(); }
        },
      });
      peer.provider.attach();
      peers.push(peer);
    }
    await until(() => peers.every((peer) => peer.provider.isSynced), 'both guest editors synchronize');
    peers[0].provider.setAwarenessField('user', { name: 'Spoofed administrator', color: '#000000' });
    await until(() => {
      const presence = peers[1].provider.awareness?.getStates().get(peers[0].doc.clientID);
      return Boolean(presence?.user?.name?.endsWith('(Gast)'));
    }, 'guest caret identity is assigned by the server');
    if (peers[2]) {
      peers[2].provider.setAwarenessField('canvas', { activity: 'editing' });
      await until(() => peers[1].provider.awareness?.getStates().get(peers[2].doc.clientID)?.canvas?.activity === 'viewing', 'read-only presence cannot claim editing');
    }
    content(peers[0].doc).insert(0, 'Alice edit ');
    content(peers[1].doc).insert(0, 'Bob edit ');
    await until(() => peers.every((peer) => content(peer.doc).toString().includes('Alice edit') && content(peer.doc).toString().includes('Bob edit')), 'concurrent edits merge');
    assert.equal(content(peers[0].doc).toString(), content(peers[1].doc).toString());
    const disconnected = new Promise<void>((resolve) => {
      const closed = () => { peers[0].socket.off('close', closed); resolve(); };
      peers[0].socket.on('close', closed);
    });
    peers[0].socket.disconnect();
    await disconnected;
    content(peers[0].doc).insert(0, 'Offline edit ');
    content(peers[1].doc).insert(0, 'Online edit ');
    await peers[0].socket.connect();
    try {
      await until(() => peers.every((peer) => content(peer.doc).toString().includes('Offline edit') && content(peer.doc).toString().includes('Online edit')), 'offline guest edits merge after reconnect');
    } catch (error) {
      console.error('Reconnect state:', peers.map((peer) => ({ status: peer.socket.status, synced: peer.provider.isSynced, revoked: peer.revoked, content: content(peer.doc).toString() })));
      throw error;
    }
    await flushCollaborationDocuments();
    const checkpointWriter = input.participants[0];
    const checkpointSession = await fileGuestCollaborationSession(checkpointWriter.id, checkpointWriter.token);
    assert.ok(checkpointSession.stateProof);
    if (input.representation === 'tiptap_blocks') assert.equal(checkpointSession.blockTreeFormatVersion, 1);
    const saved = await fileGuestCheckpoint(checkpointWriter.id, checkpointWriter.token, checkpointSession.token,
      checkpointSession.stateVector!, collaborationStateProof(peers[0].doc, Y));
    assert.equal(saved.stateProof, checkpointSession.stateProof);
    await assert.rejects(fileGuestCheckpoint(checkpointWriter.id, checkpointWriter.token, checkpointSession.token,
      checkpointSession.stateVector!, undefined), /Zustandsnachweis/);
    const history = await listFileGuestVersions(input.workspace, input.path);
    assert.ok(history.versions.length >= 1);
    const baseline = history.versions.at(-1)!;
    // Delete-only changes do not advance a Yjs state vector, but must invalidate restore.
    const oldVector = Y.encodeStateVector(peers[0].doc);
    content(peers[0].doc).delete(0, 1);
    assert.deepEqual(Y.encodeStateVector(peers[0].doc), oldVector);
    await until(() => content(peers[0].doc).toString() === content(peers[1].doc).toString(), 'delete reaches the other guest');
    await flushCollaborationDocuments();
    await assert.rejects(fileGuestCheckpoint(checkpointWriter.id, checkpointWriter.token, checkpointSession.token,
      checkpointSession.stateVector!, checkpointSession.stateProof), /synchronisiert/);
    await assert.rejects(restoreFileGuestVersion({ workspace: input.workspace, path: input.path, versionId: baseline.id,
      stateFingerprint: history.stateFingerprint, sessionId: 'owner-session' }), /inzwischen bearbeitet/);
    const fresh = await listFileGuestVersions(input.workspace, input.path);
    await restoreFileGuestVersion({ workspace: input.workspace, path: input.path, versionId: baseline.id,
      stateFingerprint: fresh.stateFingerprint, sessionId: 'owner-session' });
    await until(() => peers.every((peer) => !content(peer.doc).toString().includes('Alice edit')), 'restore reaches both guests');
    const [writer] = input.participants;
    await fileGuestService.manage(input.workspace, writer.id, { policyRevision: 1, revoke: true });
    await until(() => peers[0].revoked, 'idle guest receives access revocation', 5000);
    const before = content(peers[1].doc).toString();
    content(peers[0].doc).insert(0, 'MUST NOT ARRIVE ');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(content(peers[1].doc).toString(), before);
    if (peers[2]) {
      content(peers[2].doc).insert(0, 'READER MUST NOT WRITE ');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(content(peers[1].doc).toString(), before);
    }
    peers[1].doc.getMap('unexpected-private-root').set('invalid', true);
    await until(() => Boolean(peers[1].rejected), 'invalid guest update receives actionable error');
    assert.match(peers[1].rejected, /lokale Kopie/);
    assert.equal(peers[2]?.doc.share.has('unexpected-private-root') ?? false, false);
    console.log(`file-guest-websocket (${input.representation}): concurrent edits converge, restore guards delete-only races, restoration broadcasts, idle revocation and invalid-update rejection work`);
  } finally {
    for (const peer of peers) { peer.provider.destroy(); peer.socket.destroy(); peer.doc.destroy(); }
    await flushCollaborationDocuments();
    for (const client of websocketServer.clients) client.terminate();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
