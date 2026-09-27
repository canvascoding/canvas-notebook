import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';

import type * as Access from '../app/lib/collaboration/document-access';
import type { loadCollaborationState, PersistedCollaborationState } from '../app/lib/collaboration/persistence';

function state(): PersistedCollaborationState {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'scoped content');
  try {
    return { documentId: 'doc', workspaceId: 'workspace', organizationId: null, path: 'doc.txt',
      representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1,
      yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
      documentSequence: 1, persistedAt: 1, checkpointedAt: 1, checkpointSequence: 1,
      canonicalHash: null, serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
  } finally { doc.destroy(); }
}

function harness() {
  let ordinaryReads = 0;
  const source = readFileSync(path.resolve('app/lib/collaboration/document-access.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', output)((name: string) => {
    if (name === 'server-only') return {};
    if (name === './server-runtime') return { Y };
    if (name === './persistence') return { loadCollaborationState: async () => { ordinaryReads++; return state(); } };
    throw new Error(`Unexpected document reader dependency: ${name}`);
  }, loaded, loaded.exports);
  return { access: loaded.exports as typeof Access, ordinaryReads: () => ordinaryReads };
}

const text = (doc: Y.Doc) => doc.getText('content').toString();
const input = { documentId: 'doc', workspaceId: 'workspace', read: text };

test('ordinary reader keeps its default persisted-state lookup', async () => {
  const h = harness();
  assert.equal(await h.access.readCurrentCollaborationDocument(input), 'scoped content');
  assert.equal(h.ordinaryReads(), 1);
});

test('scoped fallback reads only through the provided state loader and destroys its temporary doc', async () => {
  const h = harness();
  let scopedReads = 0;
  let observed!: Y.Doc;
  assert.equal(await h.access.readCurrentCollaborationDocument({ ...input,
    loadState: async (id) => { assert.equal(id, 'doc'); scopedReads++; return state(); },
    read: (doc) => { observed = doc; return text(doc); },
  }), 'scoped content');
  assert.equal(h.ordinaryReads(), 0);
  assert.equal(scopedReads, 1);
  assert.equal(observed.isDestroyed, true);
});

test('scoped fallback rejects missing, archived or mismatched state before exposing content', async (t) => {
  const candidates: Array<[string, PersistedCollaborationState | null]> = [
    ['missing', null], ['archived', { ...state(), status: 'archived' }],
    ['wrong document', { ...state(), documentId: 'other' }],
    ['wrong workspace', { ...state(), workspaceId: 'other' }],
  ];
  for (const [label, candidate] of candidates) await t.test(label, async () => {
    const h = harness();
    await assert.rejects(h.access.readCurrentCollaborationDocument({ ...input,
      loadState: async () => candidate, read: () => { assert.fail('Must not expose invalid document'); },
    }), /unavailable or stale/u);
    assert.equal(h.ordinaryReads(), 0);
  });
});

test('scoped loader errors are propagated without an ordinary fallback', async () => {
  const h = harness();
  const error = new Error('Scoped transaction is closed');
  await assert.rejects(h.access.readCurrentCollaborationDocument({ ...input,
    loadState: async () => { throw error; },
  }), (caught) => caught === error);
  assert.equal(h.ordinaryReads(), 0);
});

test('callback failure still destroys the fallback doc', async () => {
  const h = harness();
  let observed!: Y.Doc;
  await assert.rejects(h.access.readCurrentCollaborationDocument({ ...input,
    loadState: async () => state(), read: (doc) => { observed = doc; throw new Error('read failed'); },
  }), /read failed/u);
  assert.equal(observed.isDestroyed, true);
});

test('live bridge receives the exact scoped loader; ordinary reads leave it undefined', async () => {
  const h = harness();
  const live = new Y.Doc();
  live.getText('content').insert(0, 'live content');
  const scoped = async () => state();
  const seen: Array<typeof loadCollaborationState | undefined> = [];
  const uninstall = h.access.installCollaborationDocumentReader(async (id, workspaceId, read, loader) => {
    assert.equal(id, 'doc'); assert.equal(workspaceId, 'workspace');
    seen.push(loader);
    return read(live);
  });
  try {
    assert.equal(await h.access.readCurrentCollaborationDocument({ ...input, loadState: scoped }), 'live content');
    assert.equal(await h.access.readCurrentCollaborationDocument(input), 'live content');
    assert.deepEqual(seen, [scoped, undefined]);
    assert.equal(h.ordinaryReads(), 0);
  } finally { uninstall(); live.destroy(); }
});
