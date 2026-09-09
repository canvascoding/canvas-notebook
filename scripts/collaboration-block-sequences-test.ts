import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSchema } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import seeds from './fixtures/collaboration-block-seeds.json';
import regressions from './fixtures/block-sequence-regressions.json';
import { BlockTreeConflict, CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { createRichMarkdownManager } from '../app/lib/markdown/rich-markdown-codec';

const schema = getSchema(richMarkdownSchemaExtensions());
const paragraph = (id: string) => schema.nodes.paragraph.create({ id }, schema.text(`⟦${id}⟧ 👋`));
const quote = (id: string, children: ProseMirrorNode[]) => schema.nodes.blockquote.create({ id }, children);
const item = (id: string) => schema.nodes.listItem.create({ id }, paragraph(`${id}-text`));
const fixture = schema.topNodeType.create(null, [
  paragraph('keep'), quote('a', [paragraph('a1'), paragraph('a2')]),
  quote('b', [quote('nested', [paragraph('n1'), paragraph('n2')]), paragraph('b1')]),
  schema.nodes.bulletList.create({ id: 'list' }, [item('item1'), item('item2')]),
  schema.nodes.taskList.create({ id: 'tasks' }, [
    schema.nodes.taskItem.create({ id: 'task1', checked: true }, paragraph('task1-text')),
    schema.nodes.taskItem.create({ id: 'task2', checked: false }, paragraph('task2-text')),
  ]), paragraph('tail'),
]);

type Receipt = { kind: 'move'; blockId: string; parentId: string | null; beforeId: string | null; operationId: string }
  | { kind: 'delete'; blockId: string; operationId: string };
type Replica = { doc: Y.Doc; tree: CollaborationBlockTree; history: Y.UndoManager; origin: symbol; generation: number };
type Packet = { source: number; bytes: Uint8Array };
type Event = Record<string, unknown>;

function random(seed: number) {
  let state = seed >>> 0;
  return (size: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return size ? state % size : 0;
  };
}

function mount(bytes: Uint8Array, index: number, generation: number): Replica {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  doc.clientID = 100 + index + generation * 10;
  const tree = new CollaborationBlockTree(doc, schema);
  const origin = Symbol(`replica-${index}-${generation}`);
  return { doc, tree, origin, generation, history: tree.createUndoManager(origin) };
}

function audit(replica: Pick<Replica, 'doc' | 'tree'>) {
  const { tree, doc } = replica;
  const projection = tree.project();
  const placed = new Set<string>();
  for (const children of projection.children.values()) for (const id of children) {
    assert.equal(placed.has(id), false, `duplicate placement: ${id}`);
    placed.add(id);
  }
  for (const id of projection.parents.keys()) {
    const ancestors = new Set<string>();
    for (let parent: string | null = id; parent !== null; parent = projection.parents.get(parent) ?? null) {
      assert.equal(ancestors.has(parent), false, `cycle through ${parent}`);
      ancestors.add(parent);
    }
  }
  const bytes = Y.encodeStateAsUpdate(doc);
  const validation = validateRichMarkdownYDoc(doc);
  assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes, 'validation must leave recovery bytes unchanged');
  let document: ProseMirrorNode | null = null;
  try { document = tree.read(); }
  catch (error) {
    const schemaFailure = error instanceof RangeError && error.message.startsWith('Invalid content for node ');
    assert((error instanceof BlockTreeConflict && error.code === 'structure_invalid') || schemaFailure,
      `unexpected read failure: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}; ${JSON.stringify(validation)}`);
    assert.equal(validation.valid, false);
    assert.equal(validation.code, 'schema_invalid', 'an incompatible merged container must be explicitly rejected');
  }
  assert.equal(validation.valid, Boolean(document), `a readable tree must checkpoint without structural or textual loss: ${JSON.stringify(validation)}`);
  if (document) {
    document.check();
    const ids = new Set<string>();
    document.descendants(node => {
      if (node.isText) return;
      assert.equal(ids.has(node.attrs.id), false);
      assert.equal(projection.deleted.has(node.attrs.id), false);
      ids.add(node.attrs.id);
    });
    assert.equal(document.firstChild?.attrs.id, 'keep', 'the protected root anchor is never moved or deleted');
  }
  return { document, state: {
    root: tree.root.toJSON(), validation,
    parents: [...projection.parents].sort(([a], [b]) => a.localeCompare(b)),
    children: [...projection.children].sort(([a], [b]) => String(a).localeCompare(String(b))),
    deleted: [...projection.deleted].sort(), conflicts: projection.conflicts,
  } };
}

function run(seed: number, events: Event[]) {
  const choose = random(seed);
  const seedDoc = new Y.Doc(); seedDoc.clientID = 1;
  CollaborationBlockTree.create(seedDoc, fixture);
  const initial = Y.encodeStateAsUpdate(seedDoc); seedDoc.destroy();
  const replicas = [0, 1, 2].map(index => mount(initial, index, 0));
  const packets: Packet[] = [];
  const pending: Array<{ packet: number; receiver: number }> = [];
  const receipts: Array<{ source: number; intent: Receipt }> = [];
  const expected = new Map<string, Set<string>>();
  fixture.descendants(node => { if (node.inlineContent) expected.set(node.attrs.id, new Set()); });
  const textOrigin = Symbol('peer-text');
  const insertOrigin = Symbol('insert-outside-placement-history');
  const uuid = crypto.randomUUID;
  let nonce = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${(++nonce).toString(16).padStart(12, '0')}`;
  const counts: Record<string, number> = {};
  const count = (kind: string) => { counts[kind] = (counts[kind] ?? 0) + 1; };
  const record = (source: number, action: () => void) => {
    const updates: Uint8Array[] = [];
    const listener = (update: Uint8Array) => updates.push(update);
    replicas[source].doc.on('update', listener);
    try { action(); } finally { replicas[source].doc.off('update', listener); }
    if (!updates.length) return;
    const packet = packets.length;
    packets.push({ source, bytes: Y.mergeUpdates(updates) });
    for (let receiver = 0; receiver < replicas.length; receiver++) if (receiver !== source) pending.push({ packet, receiver });
  };
  try {
    for (let step = 0; step < seeds.steps; step++) {
      const actor = choose(3);
      const replica = replicas[actor];
      const before = audit(replica);
      const kind = ['move', 'text', 'move', 'deliver', 'delete', 'insert', 'undo', 'deliver', 'redo', 'retry', 'restart', 'deliver'][step % 12];
      const event: Event = { step, actor, generation: replica.generation, kind }; events.push(event);
      if (kind === 'deliver') {
        if (pending.length) {
          const delivery = pending.splice(choose(pending.length), 1)[0];
          Object.assign(event, delivery);
          const target = replicas[delivery.receiver];
          Y.applyUpdate(target.doc, packets[delivery.packet].bytes);
          const once = audit(target).state;
          Y.applyUpdate(target.doc, packets[delivery.packet].bytes);
          assert.deepEqual(audit(target).state, once, 'duplicate delivery is idempotent');
          count('delivered');
        }
      } else if (kind === 'restart') {
        const bytes = Y.encodeStateAsUpdate(replica.doc);
        replica.history.destroy(); replica.doc.destroy();
        replicas[actor] = mount(bytes, actor, replica.generation + 1);
        assert.deepEqual(audit(replicas[actor]).state, before.state, 'writer restart preserves the full state, including pending updates');
        count('restarted');
      } else if (kind === 'retry') {
        const own = receipts.filter(receipt => receipt.source === actor);
        if (own.length) {
          const { intent } = own[choose(own.length)]; event.intent = intent;
          const bytes = Y.encodeStateAsUpdate(replica.doc);
          if (intent.kind === 'move') replica.tree.move(intent, replica.origin);
          else replica.tree.delete(intent.blockId, intent.operationId, replica.origin);
          assert.deepEqual(Y.encodeStateAsUpdate(replica.doc), bytes, 'retry cannot revive an undone placement after delivery or restart');
          count('retried');
        }
      } else if (kind === 'undo' || kind === 'redo') {
        record(actor, () => kind === 'undo' ? replica.history.undo() : replica.history.redo());
        count(kind);
      } else if (!before.document) {
        event.blocked = 'invalid projection requires resolution'; count('blocked');
      } else {
        const nodes: Array<{ node: ProseMirrorNode; pos: number }> = [];
        before.document.descendants((node, pos) => { if (!node.isText) nodes.push({ node, pos }); });
        const operationId = `s${seed}-a${actor}-${step}`;
        const bytes = Y.encodeStateAsUpdate(replica.doc);
        let intent: Receipt | null = null;
        try {
          record(actor, () => {
            if (kind === 'move') {
              const candidates = nodes.filter(({ node }) => node.attrs.id !== 'keep');
              const source = candidates[choose(candidates.length)].node;
              const parents = [null, ...nodes.filter(({ node }) => !node.inlineContent && !node.isLeaf).map(({ node }) => node.attrs.id as string)];
              const parentId = parents[choose(parents.length)];
              const siblings = replica.tree.project().children.get(parentId) ?? [];
              const beforeId = choose(2) || !siblings.length ? null : siblings[choose(siblings.length)];
              // Keep the root sentinel first; the other blocks still exercise nested cycles and empty containers.
              intent = { kind, blockId: source.attrs.id, parentId, beforeId: beforeId === 'keep' ? null : beforeId, operationId };
              event.intent = intent; replica.tree.move(intent, replica.origin);
            } else if (kind === 'delete') {
              const candidates = nodes.filter(({ node }) => node.attrs.id !== 'keep');
              const node = candidates[choose(candidates.length)].node;
              intent = { kind, blockId: node.attrs.id, operationId };
              event.intent = intent; replica.tree.delete(intent.blockId, operationId, replica.origin);
            } else if (kind === 'insert') {
              const id = `new-${seed}-${step}`; event.blockId = id;
              const next = before.document!.copy(before.document!.content.append(Fragment.from(paragraph(id))));
              replica.tree.applyDocumentChange(before.document!, next, insertOrigin);
              expected.set(id, new Set());
            } else {
              const candidates = nodes.filter(({ node }) => node.inlineContent);
              const node = candidates[choose(candidates.length)].node;
              const token = `«${node.attrs.id}@${step}»`; event.blockId = node.attrs.id; event.token = token;
              replica.tree.updateInlineContent(node.attrs.id, node.copy(node.content.append(Fragment.from(schema.text(token)))), textOrigin);
              expected.get(node.attrs.id)!.add(token);
            }
          });
          if (intent) receipts.push({ source: actor, intent });
          event.accepted = true; count(kind);
        } catch (error) {
          assert(error instanceof BlockTreeConflict && ['target_changed', 'structure_invalid'].includes(error.code));
          assert.deepEqual(Y.encodeStateAsUpdate(replica.doc), bytes, 'rejected structural operations cannot partially persist');
          event.rejected = error.code; count('rejected');
        }
      }
      audit(replicas[actor]);
    }
    // Quiescence delivers every accepted update, regardless of earlier transport order.
    for (const replica of replicas) for (const packet of packets) Y.applyUpdate(replica.doc, packet.bytes);
    const final = audit(replicas[0]).state;
    for (const replica of replicas) {
      assert.deepEqual(audit(replica).state, final, 'all writers converge on content, placement, conflicts and checkpoint status');
      for (const [id, tokens] of expected) {
        const text = replica.tree.content(id).toString();
        assert.ok(text.includes(`⟦${id}⟧`), `content identity changed: ${id}`);
        for (const token of tokens) assert.ok(text.includes(token), `lost accepted text ${token}`);
        for (const match of text.matchAll(/«([^»]+)»/gu)) assert.ok(tokens.has(match[0]), `text was reassigned to ${id}: ${match[0]}`);
      }
    }
    // Replay the same writes under a different delivery schedule, restarting even
    // while causal prerequisites are still missing. This observer never writes.
    const order = packets.map((_, index) => index);
    for (let index = order.length - 1; index > 0; index--) { const other = choose(index + 1); [order[index], order[other]] = [order[other], order[index]]; }
    let observer = mount(initial, 4, 0);
    try {
      for (let index = 0; index < order.length; index++) {
        const packet = order[index]; events.push({ kind: 'replay', index, packet });
        Y.applyUpdate(observer.doc, packets[packet].bytes); Y.applyUpdate(observer.doc, packets[packet].bytes);
        audit(observer);
        if (index % 3 === 0) {
          const snapshot = Y.encodeStateAsUpdate(observer.doc);
          const before = audit(observer).state;
          observer.history.destroy(); observer.doc.destroy(); observer = mount(snapshot, 4, index + 1);
          assert.deepEqual(audit(observer).state, before);
        }
      }
      assert.deepEqual(audit(observer).state, final, 'shuffled replay and pending-update restarts converge');
    } finally { observer.history.destroy(); observer.doc.destroy(); }
    return { counts, packets: packets.length, valid: final.validation.valid };
  } finally {
    crypto.randomUUID = uuid;
    for (const replica of replicas) { replica.history.destroy(); replica.doc.destroy(); }
  }
}

const requested = process.env.CANVAS_BLOCK_SEED;
const selected = requested === undefined ? seeds.seeds : [Number(requested)];
for (const regression of regressions.cases) test(`minimized regression: ${regression.name}`, () => {
  const manager = createRichMarkdownManager();
  const before = schema.nodeFromJSON(regression.document);
  const markdown = manager.serialize(before.toJSON());
  const parsed = schema.nodeFromJSON(manager.parse(markdown));
  parsed.check(); assert.ok(before.eq(parsed));
  assert.equal(manager.serialize(parsed.toJSON()), markdown);
});
for (const seed of selected) test(`seed ${seed}: identity, history, delayed duplicates and repeated binary restarts`, () => {
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  const events: Event[] = [];
  try {
    const result = run(seed, events);
    assert.ok(result.counts.move && result.counts.text && result.counts.restarted && result.counts.delivered);
    console.log(JSON.stringify({ seed, ...result }));
  } catch (error) {
    const directory = join(tmpdir(), 'canvas-block-sequence-failures'); mkdirSync(directory, { recursive: true });
    const path = join(directory, `seed-${seed}.json`);
    writeFileSync(path, JSON.stringify({ version: seeds.version, seed, steps: seeds.steps, events,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }, null, 2));
    throw new Error(`Reproduce with CANVAS_BLOCK_SEED=${seed} npm run test:collaboration:block-sequences; operation log: ${path}`, { cause: error });
  }
});
