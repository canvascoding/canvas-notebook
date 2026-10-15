/** Run: node --import tsx scripts/native-rich-local-recovery-test.ts */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '@playwright/test';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { readNativeRichLocalRecovery } from '../tests/helpers/native-rich-local-recovery';

const identity = { documentId: 'local-recovery-fixture', lifecycleGeneration: 3, representation: 'tiptap_blocks' };
const databaseName = `canvas:${identity.documentId}:${identity.lifecycleGeneration}:${identity.representation}`;
type Handler = (() => void) | null;
type Scenario = {
  values?: unknown[]; absent?: boolean; upgrade?: boolean; blocked?: boolean; openError?: boolean;
  missingStore?: boolean; transactionThrows?: boolean; cursorThrows?: boolean;
  cursorError?: boolean; transactionAbort?: boolean; deferCompletion?: boolean;
};

/** A narrow event seam, not an IndexedDB implementation or a durability mock. */
function storedLog(scenario: Scenario = {}) {
  const stats = { opens: 0, closes: 0, writes: 0, upgradeAborts: 0, modes: [] as string[] };
  let endCursor!: () => void;
  const cursorEnded = new Promise<void>(resolve => { endCursor = resolve; });
  const transaction = { oncomplete: null as Handler, onerror: null as Handler, onabort: null as Handler,
    abort() { if (!aborted) { aborted = true; queueMicrotask(() => transaction.onabort?.()); } },
    objectStore(name: string) {
      assert.equal(name, 'updates');
      return { openCursor() {
        if (scenario.cursorThrows) throw new Error('cursor unavailable');
        const request = { result: null as { value: unknown; continue(): void } | null,
          onsuccess: null as Handler, onerror: null as Handler };
        let index = 0;
        function next() {
          if (aborted) return;
          if (scenario.cursorError) { request.onerror?.(); return; }
          const values = scenario.values ?? [];
          request.result = index < values.length ? { value: values[index], continue() { index++; queueMicrotask(next); } } : null;
          request.onsuccess?.();
          if (request.result === null && !aborted) {
            endCursor();
            if (scenario.transactionAbort) queueMicrotask(() => transaction.abort());
            else if (!scenario.deferCompletion) queueMicrotask(() => transaction.oncomplete?.());
          }
        }
        queueMicrotask(next); return request;
      }, add: forbidden, put: forbidden, delete: forbidden, clear: forbidden };
    },
  };
  let aborted = false;
  function forbidden(): never { stats.writes++; throw new Error('reader attempted an IndexedDB write'); }
  const db = { name: databaseName, onversionchange: null as Handler,
    objectStoreNames: { contains: (name: string) => name === 'updates' && !scenario.missingStore },
    transaction(name: string, mode: string) {
      assert.equal(name, 'updates'); assert.equal(mode, 'readonly'); stats.modes.push(mode);
      if (scenario.transactionThrows) throw new Error('transaction unavailable');
      return transaction;
    },
    close() { stats.closes++; }, createObjectStore: forbidden, deleteObjectStore: forbidden };
  const open = { result: db, transaction: { abort() { stats.upgradeAborts++; } },
    onsuccess: null as Handler, onerror: null as Handler, onblocked: null as Handler, onupgradeneeded: null as Handler };
  const factory = {
    async databases() { return scenario.absent ? [] : [{ name: databaseName, version: 1 }]; },
    open(name: string, version?: number) {
      assert.equal(name, databaseName); assert.equal(version, undefined); stats.opens++;
      queueMicrotask(() => {
        if (scenario.upgrade) open.onupgradeneeded?.();
        else if (scenario.blocked) open.onblocked?.();
        else if (scenario.openError) open.onerror?.();
        else open.onsuccess?.();
      });
      return open;
    }, deleteDatabase: forbidden,
  };
  let evaluations = 0;
  const page = { async evaluate(callback: (name: string) => unknown, name: string) {
    evaluations++; assert.equal(name, databaseName);
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory });
    try { return await callback(name); }
    finally {
      if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
      else Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  } } as unknown as Page;
  return { page, stats, cursorEnded, complete: () => transaction.oncomplete?.(),
    lateOpenSuccess: () => open.onsuccess?.(), evaluations: () => evaluations };
}

function richDoc() {
  const doc = new Y.Doc({ gc: false }); doc.clientID = 11;
  const schema = getSchema(richMarkdownCodecExtensions());
  const id = '00000000-0000-4000-8000-000000000001';
  const tree = CollaborationBlockTree.create(doc, schema.topNodeType.createChecked(null,
    [schema.nodes.paragraph.createChecked({ id }, schema.text('ABC'))]));
  const text = tree.content(id).get(0); assert.ok(text instanceof Y.XmlText);
  return { doc, text };
}

function expected(doc: Y.Doc) {
  return { document: JSON.parse(JSON.stringify(readRichDocumentJson(doc))),
    stateProof: collaborationStateProof(doc, Y), stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64') };
}

function readOnly(log: ReturnType<typeof storedLog>) {
  assert.equal(log.stats.writes, 0);
  assert.ok(log.stats.modes.every(mode => mode === 'readonly'));
}

test('the exact browser callback waits for readonly completion, then replays real committed Undo updates', async () => {
  const source = richDoc();
  const baseline = Y.encodeStateAsUpdate(source.doc);
  const origin = {}, updates = [baseline];
  const history = new Y.UndoManager(source.text, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const collect = (update: Uint8Array) => updates.push(update.slice()); source.doc.on('update', collect);
  try {
    const before = expected(source.doc);
    source.doc.transact(() => source.text.insert(source.text.length, ' Own edit.'), origin);
    assert.ok(history.undo());
    const final = expected(source.doc);
    assert.deepEqual(final.document, before.document); assert.notEqual(final.stateProof, before.stateProof);
    const log = storedLog({ values: updates, deferCompletion: true });
    let settled = false;
    const result = readNativeRichLocalRecovery(log.page, identity).finally(() => { settled = true; });
    await log.cursorEnded;
    assert.equal(settled, false, 'cursor exhaustion alone is no committed read receipt');
    assert.equal(log.stats.closes, 0);
    log.complete();
    assert.deepEqual(await result, final);
    assert.equal(log.evaluations(), 1, 'execute exactly the callback supplied to page.evaluate');
    assert.equal(log.stats.closes, 1); assert.deepEqual(log.stats.modes, ['readonly']); readOnly(log);

    const oldLog = storedLog({ values: [baseline] });
    const old = await readNativeRichLocalRecovery(oldLog.page, identity);
    assert.deepEqual(old?.document, final.document);
    assert.notEqual(old?.stateProof, final.stateProof, 'an older same-PM log cannot certify the new deletion state');
    readOnly(oldLog); assert.equal(oldLog.stats.closes, 1);
  } finally { source.doc.off('update', collect); history.destroy(); source.doc.destroy(); }
});

test('missing or empty committed logs return null without creating or writing a database', async () => {
  for (const absent of [true, false]) {
    const log = storedLog({ absent });
    assert.equal(await readNativeRichLocalRecovery(log.page, identity), null);
    assert.equal(log.stats.opens, absent ? 0 : 1); assert.equal(log.stats.closes, absent ? 0 : 1); readOnly(log);
  }
});

test('an existence/open race aborts the upgrade instead of creating replacement storage', async () => {
  const log = storedLog({ upgrade: true });
  await assert.rejects(readNativeRichLocalRecovery(log.page, identity), /required an upgrade/u);
  assert.equal(log.stats.upgradeAborts, 1); assert.ok(log.stats.closes > 0);
  assert.deepEqual(log.stats.modes, []); readOnly(log);
});

test('open/cursor/transaction failures close connections and cannot yield partial recovery', async () => {
  const source = richDoc();
  try {
    const baseline = Y.encodeStateAsUpdate(source.doc);
    for (const scenario of [{ openError: true }, { blocked: true }, { missingStore: true },
      { transactionThrows: true }, { cursorThrows: true }, { cursorError: true }, { transactionAbort: true }]) {
      const log = storedLog({ values: [baseline], ...scenario });
      await assert.rejects(readNativeRichLocalRecovery(log.page, identity), /Native rich local recovery:/u);
      if (scenario.openError || scenario.blocked) {
        log.lateOpenSuccess();
        assert.equal(log.stats.closes, 1, 'a success arriving after rejection must close its connection');
      } else assert.ok(log.stats.closes > 0);
      readOnly(log);
    }
  } finally { source.doc.destroy(); }
});

test('binary corruption, trailing bytes and the wrong native representation fail closed', async () => {
  const source = richDoc(), plain = new Y.Doc();
  try {
    plain.getText('content').insert(0, 'not the native rich document');
    const baseline = Y.encodeStateAsUpdate(source.doc);
    for (const value of [[], {}, 'not binary', new Uint8Array(), Uint8Array.of(255),
      Uint8Array.from([...baseline, 0]), Y.encodeStateAsUpdate(plain)]) {
      const log = storedLog({ values: [value] });
      await assert.rejects(readNativeRichLocalRecovery(log.page, identity));
      assert.equal(log.stats.closes, 1); readOnly(log);
    }
    const asBuffer = storedLog({ values: [baseline.slice().buffer] });
    assert.deepEqual(await readNativeRichLocalRecovery(asBuffer.page, identity), expected(source.doc)); readOnly(asBuffer);
  } finally { source.doc.destroy(); plain.destroy(); }
});

test('unresolved missing structures or deletes in committed bytes never receive a proof', async () => {
  const source = richDoc();
  try {
    const baseline = Y.encodeStateAsUpdate(source.doc);
    for (const kind of ['structures', 'deletions'] as const) {
      const branch = new Y.Doc(); branch.clientID = 99;
      try {
        branch.getText('frontmatter').insert(0, 'A'); const vector = Y.encodeStateVector(branch);
        if (kind === 'structures') branch.getText('frontmatter').insert(1, 'B');
        else branch.getText('frontmatter').delete(0, 1);
        const missing = Y.encodeStateAsUpdate(branch, vector);
        const log = storedLog({ values: [baseline, missing] });
        await assert.rejects(readNativeRichLocalRecovery(log.page, identity), /committed log is incomplete/u);
        assert.equal(log.stats.closes, 1); readOnly(log);
      } finally { branch.destroy(); }
    }
  } finally { source.doc.destroy(); }
});

test('512 real updates are accepted; a 513th update or more than 4 MiB rejects the entire read', async () => {
  const source = richDoc();
  try {
    const baseline = Y.encodeStateAsUpdate(source.doc);
    const bounded = storedLog({ values: Array.from({ length: 512 }, () => baseline) });
    assert.deepEqual(await readNativeRichLocalRecovery(bounded.page, identity), expected(source.doc)); readOnly(bounded);
    for (const values of [Array.from({ length: 513 }, () => baseline), [new Uint8Array(4 * 1024 * 1024 + 1)]]) {
      const log = storedLog({ values });
      await assert.rejects(readNativeRichLocalRecovery(log.page, identity), /bound exceeded/u);
      assert.equal(log.stats.closes, 1); readOnly(log);
    }
  } finally { source.doc.destroy(); }
});
