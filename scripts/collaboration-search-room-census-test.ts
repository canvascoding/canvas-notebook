import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, test } from 'node:test';
import { Document, Hocuspocus } from '@hocuspocus/server';
import ts from 'typescript';
import * as Y from 'yjs';

import {
  captureLocalCollaborationSearchRooms,
  installCollaborationSearchRoomCensus,
  SearchRoomCensusChangedError,
  type SearchRoomCensus,
  type SearchRoomVisibility,
} from '../app/lib/collaboration/search-room-census';
import type { CollaborationRoomOwnerFence } from '../app/lib/collaboration/room-owner';

// These are observer contract tests. They execute the real API against real
// Hocuspocus maps and Yjs events, without opening a listener or a database. The
// controlled identity/owner callbacks are not authorization or SQL-owner proof.
type Source = Parameters<typeof installCollaborationSearchRoomCensus>[0];
type Identity = NonNullable<ReturnType<Source['identity']>>;
type MutableIdentity = { -readonly [K in keyof Identity]: Identity[K] };
type ObservedDoc = Y.Doc & { _observers: Map<string, Set<unknown>> };
const workspaceId = 'search-census-workspace';

function identity(documentId: string, overrides: Partial<Identity> = {}): MutableIdentity {
  return { documentId, workspaceId, organizationId: 'search-census-organization',
    path: `${documentId}.md`, lifecycleGeneration: 1, representation: 'plain_text',
    schemaVersion: 1, ...overrides };
}

function owner(scope: Identity, overrides: Partial<CollaborationRoomOwnerFence> = {}): CollaborationRoomOwnerFence {
  assert.notEqual(scope.representation, 'excalidraw_scene');
  return { scope: { ...scope, representation: scope.representation as CollaborationRoomOwnerFence['scope']['representation'] },
    epoch: 7, token: `owner-token-${scope.documentId}`, backendPid: 4242,
    backendStart: '1780000000.123456', ...overrides };
}

function fixture() {
  const server = new Hocuspocus();
  const identities = new WeakMap<Y.Doc, MutableIdentity>();
  const owners = new WeakMap<Y.Doc, CollaborationRoomOwnerFence | Error>();
  const ownedDocuments = new Set<Document>();
  const draining = new Set<string>();
  const registrations: Array<() => void> = [];
  let available = true;
  const source: Source = {
    maps: () => ({ documents: server.documents, loadingDocuments: server.loadingDocuments,
      unloadingDocuments: server.unloadingDocuments }),
    identity: document => identities.get(document),
    owner: document => {
      const value = owners.get(document);
      if (value instanceof Error) throw value;
      return value;
    },
    isDraining: documentId => draining.has(documentId),
    assertAvailable: () => { if (!available) throw new Error('Controlled unavailable runtime'); },
  };
  return { server, source, identities, owners, draining,
    add(documentId: string, overrides: Partial<Identity> = {}) {
      const document = new Document(documentId);
      document.isLoading = false;
      ownedDocuments.add(document);
      const scope = identity(documentId, overrides);
      identities.set(document, scope);
      if (scope.representation !== 'excalidraw_scene') owners.set(document, owner(scope));
      server.documents.set(documentId, document);
      return document;
    },
    install() {
      const uninstall = installCollaborationSearchRoomCensus(source);
      registrations.push(uninstall);
      return uninstall;
    },
    setAvailable(value: boolean) { available = value; },
    dispose() {
      for (const uninstall of registrations.reverse()) uninstall();
      server.documents.clear(); server.loadingDocuments.clear(); server.unloadingDocuments.clear();
      for (const document of ownedDocuments) if (!document.isDestroyed) document.destroy();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
function withFixture(run: (value: Fixture) => void): void {
  const value = fixture();
  try { run(value); } finally { value.dispose(); }
}
function capture(limit?: number, visibility?: SearchRoomVisibility) {
  return captureLocalCollaborationSearchRooms(workspaceId, limit, visibility);
}
function changed(snapshot: SearchRoomCensus): void {
  assert.throws(() => snapshot.assertCurrent(), (error: unknown) => error instanceof SearchRoomCensusChangedError
    && error.code === 'SEARCH_ROOM_CENSUS_CHANGED');
}
function observers(document: Y.Doc) {
  const events = (document as ObservedDoc)._observers;
  return Object.fromEntries(['beforeTransaction', 'update', 'destroy'].map(event => [event, events.get(event)?.size ?? 0]));
}
function plusObserver(base: ReturnType<typeof observers>) {
  return Object.fromEntries(Object.entries(base).map(([event, count]) => [event, count + 1]));
}

describe('same-process loaded-room search census', { concurrency: false }, () => {
  test('missing provider is unknown, and an install/uninstall ABA invalidates the old absent handle', () => {
    const absent = capture();
    assert.equal(absent.serverEpoch, null);
    assert.equal(absent.complete, false);
    assert.equal(absent.completeFor, 'same_process_loaded_text_rooms');
    assert.equal(absent.remoteCoverage, 'unknown');
    assert.deepEqual(absent.rooms, []);
    assert.deepEqual(absent.uncertainty, ['not_installed']);
    absent.assertCurrent();
    withFixture(h => {
      const uninstall = h.install();
      const installed = capture();
      assert.equal(installed.complete, true);
      assert.notEqual(installed.serverEpoch, null);
      changed(absent);
      uninstall();
      changed(installed);
      changed(absent);
      const absentAgain = capture();
      assert.notEqual(absentAgain.revision, absent.revision);
      uninstall();
      absentAgain.assertCurrent();
    });
  });

  test('all loaded text representations remain candidates with zero connections; foreign and scene rooms are omitted', () => {
    withFixture(h => {
      const plain = h.add('plain', { path: 'ordinary.txt' });
      const xml = h.add('xml', { representation: 'tiptap_xml' });
      const blocks = h.add('blocks', { representation: 'tiptap_blocks' });
      plain.getText('content').insert(0, 'plain text');
      const xmlText = new Y.XmlText(); xmlText.insert(0, 'XML text');
      xml.getXmlFragment('default').insert(0, [xmlText]);
      blocks.getMap('blocks').set('block-1', new Y.Text('block text'));
      h.add('scene', { representation: 'excalidraw_scene' });
      h.add('foreign', { workspaceId: 'another-workspace' });
      for (const document of [plain, xml, blocks]) assert.equal(document.getConnectionsCount(), 0);
      h.install();
      const snapshot = capture();
      assert.equal(snapshot.complete, true);
      assert.equal(snapshot.remoteCoverage, 'unknown');
      assert.deepEqual(snapshot.uncertainty, []);
      assert.deepEqual(snapshot.rooms.map(room => [room.documentId, room.representation]), [
        ['blocks', 'tiptap_blocks'], ['plain', 'plain_text'], ['xml', 'tiptap_xml'],
      ]);
      for (const document of [plain, xml, blocks]) assert.equal(snapshot.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), true);
      snapshot.assertCurrent();
      assert.equal(Object.isFrozen(snapshot), true);
      assert.equal(Object.isFrozen(snapshot.rooms), true);
      assert.equal(snapshot.rooms.every(room => Object.isFrozen(room) && Object.isFrozen(room.issues)), true);
      assert.equal(JSON.stringify(snapshot).includes('owner-token-'), false);
    });
  });

  test('real Plain, XML and Blocks updates each invalidate an observed room', async t => {
    const representations = ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const;
    for (const representation of representations) await t.test(representation, () => {
      withFixture(h => {
        const document = h.add('updated', { representation });
        h.install();
        const snapshot = capture();
        if (representation === 'plain_text') document.getText('content').insert(0, 'new text');
        else if (representation === 'tiptap_xml') {
          const paragraph = new Y.XmlElement('paragraph');
          paragraph.insert(0, [new Y.XmlText('new text')]);
          document.getXmlFragment('default').insert(0, [paragraph]);
        } else document.getMap('blocks').set('block-1', new Y.Text('new text'));
        changed(snapshot);
        const current = capture();
        assert.equal(current.complete, true);
        assert.notEqual(current.revision, snapshot.revision);
        current.assertCurrent();
      });
    });
  });

  test('a deletion invalidates the snapshot even when the real Yjs state vector is unchanged', () => {
    withFixture(h => {
      const document = h.add('deleted');
      const text = document.getText('content'); text.insert(0, 'abcdef');
      h.install();
      const snapshot = capture(), before = Y.encodeStateVector(document);
      text.delete(1, 3);
      assert.equal(text.toString(), 'aef');
      assert.deepEqual(Y.encodeStateVector(document), before, 'deletes alone do not advance the struct clock');
      changed(snapshot);
      capture().assertCurrent();
    });
  });

  test('delete/undo ABA cannot revive a snapshot whose visible text has returned to the original value', () => {
    withFixture(h => {
      const document = h.add('undo');
      const text = document.getText('content'); text.insert(0, 'original text');
      const undo = new Y.UndoManager(text, { captureTimeout: 0 });
      try {
        h.install();
        const snapshot = capture();
        text.delete(0, text.length);
        assert.equal(text.toString(), '');
        undo.undo();
        assert.equal(text.toString(), 'original text');
        changed(snapshot);
        assert.notEqual(capture().revision, snapshot.revision);
      } finally { undo.destroy(); }
    });
  });

  test('a previously registered throwing update listener cannot hide an already integrated edit', () => {
    withFixture(h => {
      const document = h.add('throwing-listener'), failure = new Error('Earlier update observer failed');
      const throwing = () => { throw failure; };
      document.on('update', throwing);
      try {
        h.install();
        const snapshot = capture();
        assert.throws(() => document.getText('content').insert(0, 'integrated'), error => error === failure);
        assert.equal(document.getText('content').toString(), 'integrated');
        changed(snapshot);
      } finally { document.off('update', throwing); }
    });
  });

  test('dependency-only Y.applyUpdate invalidates even without an update event or a state-vector change', async t => {
    for (const kind of ['pending structs', 'pending delete set'] as const) await t.test(kind, () => {
      withFixture(h => {
        const document = h.add('pending'), sender = new Y.Doc();
        try {
          sender.getText('content').insert(0, 'a');
          const known = Y.encodeStateVector(sender);
          if (kind === 'pending structs') sender.getText('content').insert(1, 'b');
          else sender.getText('content').delete(0, 1);
          const missingDependencyUpdate = Y.encodeStateAsUpdate(sender, known);
          h.install();
          const snapshot = capture(), before = Y.encodeStateVector(document);
          let updates = 0;
          const onUpdate = () => { updates++; };
          document.on('update', onUpdate);
          try { Y.applyUpdate(document, missingDependencyUpdate); }
          finally { document.off('update', onUpdate); }
          assert.equal(updates, 0, 'the missing predecessor must prevent an integrated update event');
          assert.deepEqual(Y.encodeStateVector(document), before);
          if (kind === 'pending structs') assert.notEqual(document.store.pendingStructs, null);
          else assert.notEqual(document.store.pendingDs, null);
          changed(snapshot);
        } finally { sender.destroy(); }
      });
    });
  });

  test('a capture inside a live Yjs transaction is explicitly uncertain and expires after cleanup', () => {
    withFixture(h => {
      const document = h.add('transaction');
      h.install();
      let inside: SearchRoomCensus | undefined;
      document.transact(() => {
        inside = capture();
        assert.equal(inside.complete, false);
        assert.deepEqual(inside.uncertainty, ['transaction_active']);
        assert.deepEqual(inside.rooms[0].issues, ['transaction_active']);
        assert.equal(inside.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), false);
        inside.assertCurrent();
      });
      assert.ok(inside);
      changed(inside);
      assert.equal(capture().complete, true);
    });
  });

  test('awareness and connection bookkeeping do not pretend that document content changed', () => {
    withFixture(h => {
      const document = h.add('presence');
      h.install();
      const snapshot = capture(), before = Y.encodeStateAsUpdate(document);
      document.awareness.setLocalState({ cursor: { anchor: 2, head: 5 } });
      document.awareness.setLocalStateField('user', { name: 'Visible user' });
      document.directConnectionsCount = 3;
      document.directConnectionsCount = 0;
      document.awareness.setLocalState(null);
      assert.deepEqual(Y.encodeStateAsUpdate(document), before);
      snapshot.assertCurrent();
      assert.equal(capture().revision, snapshot.revision);
    });
  });

  test('membership removal and an observed remove/reinsert ABA expire the original handle and detach listeners', () => {
    withFixture(h => {
      const document = h.add('member'), base = observers(document);
      h.install();
      const snapshot = capture();
      assert.deepEqual(observers(document), plusObserver(base));
      h.server.documents.delete('member');
      changed(snapshot);
      const absent = capture();
      assert.equal(absent.complete, true);
      assert.deepEqual(absent.rooms, []);
      assert.deepEqual(observers(document), base);
      h.server.documents.set('member', document);
      changed(absent);
      const returned = capture();
      assert.notEqual(returned.revision, snapshot.revision);
      changed(snapshot);
      assert.deepEqual(observers(document), plusObserver(base));
    });
  });

  test('replacing a document by an equal-content/equal-state-vector Doc is detected by object identity', () => {
    withFixture(h => {
      const first = h.add('replacement'); first.getText('content').insert(0, 'same content');
      const base = observers(first);
      h.install();
      const snapshot = capture(), scope = h.identities.get(first)!;
      const second = h.add('replacement');
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
      h.identities.set(second, scope);
      assert.equal(second.getText('content').toString(), first.getText('content').toString());
      assert.deepEqual(Y.encodeStateVector(second), Y.encodeStateVector(first));
      changed(snapshot);
      assert.deepEqual(observers(first), base);
      assert.equal(capture().complete, true);
    });
  });

  test('identity replacement with identical values and actual scope value changes invalidate separately', async t => {
    await t.test('equal values in a new identity object', () => {
      withFixture(h => {
        const document = h.add('identity');
        h.install();
        const snapshot = capture();
        h.identities.set(document, { ...h.identities.get(document)! });
        changed(snapshot);
        assert.equal(capture().complete, true);
      });
    });
    const changes: Array<[string, Partial<Identity>]> = [
      ['path', { path: 'renamed/note.md' }], ['generation', { lifecycleGeneration: 2 }],
      ['schema', { schemaVersion: 2 }], ['organization', { organizationId: null }],
      ['representation', { representation: 'tiptap_blocks' }], ['workspace', { workspaceId: 'other-workspace' }],
    ];
    for (const [label, patch] of changes) await t.test(label, () => {
      withFixture(h => {
        const document = h.add('identity'), scope = h.identities.get(document)!;
        h.install();
        const snapshot = capture(), originalPath = snapshot.rooms[0].path;
        Object.assign(scope, patch);
        h.owners.set(document, owner(scope));
        changed(snapshot);
        assert.equal(snapshot.rooms[0].path, originalPath, 'a published scope is a copied observation');
        const current = capture();
        assert.equal(current.complete, true);
        assert.equal(current.rooms.length, label === 'workspace' ? 0 : 1);
      });
    });
  });

  test('each actual Hocuspocus map replacement invalidates even when every entry is identical', async t => {
    for (const kind of ['documents', 'loadingDocuments', 'unloadingDocuments'] as const) await t.test(kind, () => {
      withFixture(h => {
        h.add('map-identity');
        h.install();
        const snapshot = capture();
        if (kind === 'documents') h.server.documents = new Map(h.server.documents);
        else if (kind === 'loadingDocuments') h.server.loadingDocuments = new Map(h.server.loadingDocuments);
        else h.server.unloadingDocuments = new Map(h.server.unloadingDocuments);
        changed(snapshot);
        assert.equal(capture().complete, true);
      });
    });
  });

  test('missing or invalid room identities cannot be counted as a complete empty census', async t => {
    const cases: Array<[string, (h: Fixture, document: Document) => void, string]> = [
      ['missing', (h, document) => { h.identities.delete(document); }, 'identity_missing'],
      ['key mismatch', (h, document) => { h.identities.get(document)!.documentId = 'wrong-id'; }, 'identity_invalid'],
      ['invalid generation', (h, document) => { h.identities.get(document)!.lifecycleGeneration = 0; }, 'identity_invalid'],
      ['invalid path', (h, document) => { h.identities.get(document)!.path = 'bad\u0000path'; }, 'identity_invalid'],
    ];
    for (const [label, modify, issue] of cases) await t.test(label, () => {
      withFixture(h => {
        const document = h.add('unknown');
        h.install();
        const snapshot = capture();
        modify(h, document);
        changed(snapshot);
        const current = capture();
        assert.equal(current.complete, false);
        assert.deepEqual(current.rooms, []);
        assert.deepEqual(current.uncertainty, [issue]);
      });
    });
  });

  test('loading, unloading, draining, unavailable and destroyed states are explicit uncertainties', async t => {
    const cases: Array<[string, (h: Fixture, document: Document) => void, string]> = [
      ['loading property', (_h, document) => { document.isLoading = true; }, 'loading'],
      ['loading map', (h, document) => { h.server.loadingDocuments.set('state', Promise.resolve(document)); }, 'loading'],
      ['unloading map', h => { h.server.unloadingDocuments.set('state', Promise.resolve()); }, 'unloading'],
      ['draining', h => { h.draining.add('state'); }, 'draining'],
      ['unavailable', h => { h.setAvailable(false); }, 'runtime_unavailable'],
      ['destroyed', (_h, document) => { document.destroy(); }, 'destroyed'],
    ];
    for (const [label, modify, issue] of cases) await t.test(label, () => {
      withFixture(h => {
        const document = h.add('state');
        h.install();
        const snapshot = capture();
        modify(h, document);
        changed(snapshot);
        const current = capture();
        assert.equal(current.complete, false);
        assert.ok(current.uncertainty.includes(issue as typeof current.uncertainty[number]));
        if (issue !== 'runtime_unavailable') assert.equal(current.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), false);
      });
    });
  });

  test('not-yet-loaded entries remain unknown and pending promise replacement is observable', () => {
    withFixture(h => {
      const pending = h.add('not-yet-loaded');
      h.server.documents.delete('not-yet-loaded');
      h.server.loadingDocuments.set('not-yet-loaded', Promise.resolve(pending));
      h.server.unloadingDocuments.set('unknown-unloading', Promise.resolve());
      h.install();
      const snapshot = capture();
      assert.equal(snapshot.complete, false);
      assert.deepEqual(snapshot.rooms, []);
      assert.deepEqual(snapshot.uncertainty, ['loading', 'unloading']);
      snapshot.assertCurrent();
      h.server.loadingDocuments.set('not-yet-loaded', Promise.resolve(pending));
      changed(snapshot);
      const replacement = capture();
      h.server.loadingDocuments.clear(); h.server.unloadingDocuments.clear();
      changed(replacement);
      assert.equal(capture().complete, true);
    });
  });

  test('known foreign workspace and non-text pending rooms do not create false local uncertainty', () => {
    withFixture(h => {
      const foreign = h.add('foreign', { workspaceId: 'another-workspace' });
      const scene = h.add('scene', { representation: 'excalidraw_scene' });
      for (const document of [foreign, scene]) {
        h.server.loadingDocuments.set(document.name, Promise.resolve(document));
        h.server.unloadingDocuments.set(document.name, Promise.resolve());
        h.draining.add(document.name);
      }
      h.install();
      const snapshot = capture();
      assert.equal(snapshot.complete, true);
      assert.deepEqual(snapshot.rooms, []);
      assert.deepEqual(snapshot.uncertainty, []);
      snapshot.assertCurrent();
    });
  });

  test('visibility is bound before candidates and owner evidence, and excluded known rooms do not disturb visible snapshots', () => {
    withFixture(h => {
      const visible = h.add('visible', { path: 'folder/visible.md' });
      const hiddenFile = h.add('hidden-file', { path: '.secret.md' });
      const hiddenFolder = h.add('hidden-folder', { path: 'folder/.hidden/doc' });
      h.install();
      const all = capture(), filtered = capture(undefined, 'exclude_dot_segments');
      assert.equal(all.visibility, 'all');
      assert.equal(filtered.visibility, 'exclude_dot_segments');
      assert.notEqual(all.revision, filtered.revision);
      assert.deepEqual(all.rooms.map(room => room.documentId), ['hidden-file', 'hidden-folder', 'visible']);
      assert.deepEqual(filtered.rooms.map(room => room.documentId), ['visible']);
      assert.equal(filtered.complete, true);
      assert.equal(filtered.coversOwner(h.owners.get(visible) as CollaborationRoomOwnerFence), true);
      for (const document of [hiddenFile, hiddenFolder]) {
        assert.equal(all.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), true);
        assert.equal(filtered.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), false);
      }
      hiddenFile.getText('content').insert(0, 'secret change');
      hiddenFolder.getText('content').insert(0, 'another secret change');
      changed(all);
      filtered.assertCurrent();
      assert.equal(capture(undefined, 'exclude_dot_segments').revision, filtered.revision);
      h.server.loadingDocuments.set('unresolved-hidden-or-visible', Promise.resolve(visible));
      changed(filtered);
      const pending = capture(undefined, 'exclude_dot_segments');
      assert.equal(pending.complete, false);
      assert.deepEqual(pending.rooms.map(room => room.documentId), ['visible']);
      assert.deepEqual(pending.uncertainty, ['loading']);
    });
  });

  test('absent, throwing and mismatched owner sources remain explicit rather than usable owner observations', async t => {
    const cases: Array<[string, (h: Fixture, document: Document) => void, string]> = [
      ['missing', (h, document) => { h.owners.delete(document); }, 'owner_unfenced'],
      ['lost', (h, document) => { h.owners.set(document, new Error('Owner session lost')); }, 'owner_lost'],
      ['scope mismatch', (h, document) => {
        const fence = h.owners.get(document) as CollaborationRoomOwnerFence;
        h.owners.set(document, { ...fence, scope: { ...fence.scope, path: 'another.md' } });
      }, 'owner_lost'],
      ['invalid token', (h, document) => { h.owners.set(document, owner(h.identities.get(document)!, { token: '' })); }, 'owner_lost'],
      ['invalid epoch', (h, document) => { h.owners.set(document, owner(h.identities.get(document)!, { epoch: 0 })); }, 'owner_lost'],
      ['invalid PID', (h, document) => { h.owners.set(document, owner(h.identities.get(document)!, { backendPid: 0 })); }, 'owner_lost'],
      ['invalid start', (h, document) => { h.owners.set(document, owner(h.identities.get(document)!, { backendStart: '' })); }, 'owner_lost'],
    ];
    for (const [label, modify, issue] of cases) await t.test(label, () => {
      withFixture(h => {
        const document = h.add('owner'), original = h.owners.get(document) as CollaborationRoomOwnerFence;
        h.install();
        const snapshot = capture();
        modify(h, document);
        changed(snapshot);
        const current = capture();
        assert.equal(current.complete, false);
        assert.deepEqual(current.uncertainty, [issue]);
        assert.equal(current.coversOwner(original), false);
      });
    });
  });

  test('coversOwner compares every owner and scope field exactly, without object-identity requirements', () => {
    withFixture(h => {
      const document = h.add('owner'), actual = h.owners.get(document) as CollaborationRoomOwnerFence;
      h.install();
      const snapshot = capture();
      assert.equal(snapshot.coversOwner({ ...actual, scope: { ...actual.scope } }), true);
      const candidates: CollaborationRoomOwnerFence[] = [
        { ...actual, token: 'other-token' }, { ...actual, epoch: actual.epoch + 1 },
        { ...actual, backendPid: actual.backendPid + 1 }, { ...actual, backendStart: `${actual.backendStart}0` },
        { ...actual, scope: { ...actual.scope, documentId: 'another-document' } },
        { ...actual, scope: { ...actual.scope, workspaceId: 'another-workspace' } },
        { ...actual, scope: { ...actual.scope, organizationId: null } },
        { ...actual, scope: { ...actual.scope, path: 'another.md' } },
        { ...actual, scope: { ...actual.scope, lifecycleGeneration: 2 } },
        { ...actual, scope: { ...actual.scope, representation: 'tiptap_xml' } },
        { ...actual, scope: { ...actual.scope, schemaVersion: 2 } },
      ];
      for (const candidate of candidates) assert.equal(snapshot.coversOwner(candidate), false);
      snapshot.assertCurrent();
      h.owners.set(document, { ...actual, token: 'replacement-owner-token' });
      changed(snapshot);
      const current = capture();
      assert.equal(current.complete, true);
      assert.equal(current.coversOwner(actual), false);
      assert.equal(current.coversOwner(h.owners.get(document) as CollaborationRoomOwnerFence), true);
    });
  });

  test('bounded capture is explicitly incomplete and never reports an unseen later workspace room as absent', () => {
    withFixture(h => {
      h.add('foreign-first', { workspaceId: 'another-workspace' });
      h.add('local-later');
      h.install();
      const limited = capture(1);
      assert.equal(limited.complete, false);
      assert.deepEqual(limited.uncertainty, ['limit']);
      assert.deepEqual(limited.rooms, []);
      assert.equal(limited.remoteCoverage, 'unknown');
      limited.assertCurrent();
      const enough = capture(2);
      assert.equal(enough.complete, true);
      assert.deepEqual(enough.rooms.map(room => room.documentId), ['local-later']);
    });
  });

  test('pending-map limits preserve both uncertainty and the fact that coverage was truncated', () => {
    withFixture(h => {
      const document = h.add('outside'); h.server.documents.clear();
      h.server.loadingDocuments.set('pending-a', Promise.resolve(document));
      h.server.loadingDocuments.set('pending-b', Promise.resolve(document));
      h.install();
      const snapshot = capture(1);
      assert.equal(snapshot.complete, false);
      assert.deepEqual(snapshot.rooms, []);
      assert.deepEqual(snapshot.uncertainty, ['limit', 'loading']);
    });
  });

  test('selection bounds reject malformed workspaces and limits before any census', () => {
    for (const value of ['', 'bad\u0000workspace', '\ud800', 'x'.repeat(1025)]) {
      assert.throws(() => captureLocalCollaborationSearchRooms(value), TypeError);
    }
    for (const value of [0, -1, 1.5, Number.NaN, Infinity, 4097]) {
      assert.throws(() => capture(value), TypeError);
    }
  });

  test('replacement disposes old listeners, stale cleanup cannot remove the current provider, and close cleans all observers', () => {
    const first = fixture(), second = fixture();
    try {
      const oldDocument = first.add('first'), newDocument = second.add('second');
      const oldBase = observers(oldDocument), newBase = observers(newDocument);
      const closeFirst = first.install(), oldSnapshot = capture();
      assert.deepEqual(observers(oldDocument), plusObserver(oldBase));
      const closeSecond = second.install();
      assert.deepEqual(observers(oldDocument), oldBase);
      changed(oldSnapshot);
      const current = capture();
      assert.notEqual(current.serverEpoch, oldSnapshot.serverEpoch);
      assert.deepEqual(current.rooms.map(room => room.documentId), ['second']);
      assert.deepEqual(observers(newDocument), plusObserver(newBase));
      for (let index = 0; index < 12; index++) current.assertCurrent();
      assert.deepEqual(observers(newDocument), plusObserver(newBase), 'repeated captures never accumulate observers');
      closeFirst();
      current.assertCurrent();
      assert.equal(capture().serverEpoch, current.serverEpoch);
      closeSecond();
      changed(current);
      assert.deepEqual(observers(newDocument), newBase);
      const absent = capture();
      assert.deepEqual(absent.uncertainty, ['not_installed']);
      closeFirst(); closeSecond();
      absent.assertCurrent();
    } finally { second.dispose(); first.dispose(); }
  });

  test('separate unchanged module copies share the provider and expose the caller copy error class', () => {
    // Same source evaluated twice, with real imports and no source rewriting.
    // This probes the raw-server/compiled-consumer class boundary; it is not a
    // compiled Next.js or HTTP acceptance claim.
    const filename = path.resolve('app/lib/collaboration/search-room-census.ts');
    const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    });
    const copy = {} as typeof import('../app/lib/collaboration/search-room-census');
    new Function('require', 'module', 'exports', compiled.outputText)(createRequire(filename), { exports: copy }, copy);
    assert.notEqual(copy.SearchRoomCensusChangedError, SearchRoomCensusChangedError);
    withFixture(h => {
      const document = h.add('separate-copy');
      const close = copy.installCollaborationSearchRoomCensus(h.source);
      try {
        const snapshot = capture();
        assert.deepEqual(snapshot.rooms.map(room => room.documentId), ['separate-copy']);
        snapshot.assertCurrent();
        document.getText('content').insert(0, 'changed through the real Yjs document');
        changed(snapshot);
      } finally { close(); }
    });
  });
});
