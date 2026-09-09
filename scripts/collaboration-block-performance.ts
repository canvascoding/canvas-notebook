import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { getSchema } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import type { BlockPlacementOperation } from '../app/lib/collaboration/block-tree-placement';
import { validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { createBlockReference, resolveBlockReference } from '../app/lib/editor/block-reference';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';

const schema = getSchema(richMarkdownCodecExtensions());
const samples = 15;
const warmups = 3;
const cases = [
  { name: 'flat-100', kind: 'flat', size: 100, history: 0 },
  { name: 'flat-1000', kind: 'flat', size: 1000, history: 0 },
  { name: 'flat-5000', kind: 'flat', size: 5000, history: 0 },
  { name: 'flat-1000-history-1000', kind: 'flat', size: 1000, history: 1000 },
  { name: 'flat-1000-history-10000', kind: 'flat', size: 1000, history: 10000 },
  { name: 'nested-depth-64', kind: 'nested', size: 64, history: 1000 },
  { name: 'table-80-by-6', kind: 'table', size: 80, history: 1000 },
] as const;

function fixture(kind: string, size: number): ProseMirrorNode {
  let sequence = 0;
  const attrs = () => ({ id: `benchmark-${sequence++}` });
  const paragraph = () => schema.nodes.paragraph.create(attrs(), [
    schema.text('A stable paragraph with '),
    schema.text('formatted text', [schema.marks.bold.create()]),
    schema.text(' and a preserved ending.'),
  ]);
  if (kind === 'flat') return schema.topNodeType.create(null, Array.from({ length: size }, paragraph));
  if (kind === 'nested') {
    let node = paragraph();
    for (let depth = 0; depth < size; depth++) {
      node = schema.nodes.blockquote.create(attrs(), [paragraph(), node, paragraph(), paragraph()]);
    }
    return schema.topNodeType.create(null, [node, paragraph()]);
  }
  const rows = Array.from({ length: size }, (_, row) => schema.nodes.tableRow.create(attrs(),
    Array.from({ length: 6 }, () => (row === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell)
      .create(attrs(), paragraph()))));
  return schema.topNodeType.create(null, [schema.nodes.table.create(attrs(), rows), paragraph()]);
}

function measure(action: () => void, divisor = 1) {
  const elapsed: number[] = [];
  for (let i = 0; i < warmups + samples; i++) {
    const start = performance.now();
    action();
    if (i >= warmups) elapsed.push((performance.now() - start) / divisor);
  }
  elapsed.sort((a, b) => a - b);
  return { p50Ms: elapsed[Math.floor(samples * 0.5)], p95Ms: elapsed[Math.ceil(samples * 0.95) - 1] };
}

function identityContents(doc: ProseMirrorNode) {
  const contents = new Map<string, string>();
  doc.descendants(node => {
    if (node.isText) return;
    assert.equal(contents.has(node.attrs.id), false, 'block identities must be unique');
    contents.set(node.attrs.id, node.textContent);
  });
  return new Map([...contents].sort(([a], [b]) => a.localeCompare(b)));
}

function runCase(spec: typeof cases[number]) {
  console.log(`Measuring ${spec.name}...`);
  const doc = new Y.Doc();
  doc.clientID = 10;
  const peer = new Y.Doc();
  const restored = new Y.Doc();
  try {
    const initial = fixture(spec.kind, spec.size);
    const tree = CollaborationBlockTree.create(doc, initial);
    const movingId = initial.child(0).attrs.id as string;
    const anchorId = initial.child(1).attrs.id as string;
    const initialContents = identityContents(initial);
    // Populate a valid persisted history outside the timings. Alternating
    // placements are causally ordered exactly as two map inserts per move;
    // this avoids spending the benchmark setup on quadratic repeated replay.
    const firstClock = [...Y.decodeStateVector(Y.encodeStateVector(doc)).values()].reduce((a, b) => a + b, 1);
    doc.transact(() => {
      for (let i = 0; i < spec.history; i++) {
        const id = `history-${i}`;
        const operation: BlockPlacementOperation = { id, transactionId: id, ordinal: 0,
          clock: firstClock + i * 2, actor: doc.clientID, kind: 'move', blockId: movingId,
          parentId: null, beforeId: i % 2 === 0 ? null : anchorId };
        tree.operations.set(id, operation);
        tree.receipts.set(id, operation);
      }
    }, 'benchmark-history');
    assert.deepEqual(tree.project().conflicts, []);
    assert.deepEqual(tree.read().toJSON(), initial.toJSON(), 'even history restores the original placement');
    const bytesBefore = Y.encodeStateAsUpdate(doc).byteLength;
    const project = measure(() => { tree.project(); });
    const read = measure(() => { tree.read(); });
    const scope = {};
    const reference = createBlockReference(scope, initial.child(1));
    const coldTimes: number[] = [];
    for (let i = 0; i < warmups + samples; i++) {
      const current = tree.read(); // projection is excluded from target-index timing
      const start = performance.now();
      assert.equal(resolveBlockReference(current, scope, reference)?.node.attrs.id, anchorId);
      if (i >= warmups) coldTimes.push(performance.now() - start);
    }
    coldTimes.sort((a, b) => a - b);
    const referenceCold = { p50Ms: coldTimes[Math.floor(samples * 0.5)], p95Ms: coldTimes[Math.ceil(samples * 0.95) - 1] };
    const stable = tree.read();
    const references = [reference];
    stable.descendants(node => { if (!node.isText) references.push(createBlockReference(scope, node)); });
    let resolved = 0;
    const referenceWarm = measure(() => {
      for (let i = 0; i < 10_000; i++) {
        if (resolveBlockReference(stable, scope, references[i % references.length])) resolved++;
      }
    }, 10_000);
    assert.equal(resolved, (warmups + samples) * 10_000);
    let moveSequence = 0;
    const move = measure(() => {
      const i = moveSequence++;
      tree.move({ blockId: movingId, parentId: null, beforeId: i % 2 === 0 ? null : anchorId,
        operationId: `measured-${i}` }, 'benchmark-move');
    });
    assert.deepEqual(identityContents(tree.read()), initialContents, 'measured moves preserve all identities and contents');

    // An independent peer edits a leaf while its containing block moves. The
    // timings above are core costs; these guards verify that the large fixture
    // still preserves the collaboration and persistence invariants.
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerTree = new CollaborationBlockTree(peer, schema);
    let leafId: string | undefined;
    initial.child(0).descendants(node => { if (!leafId && node.isTextblock) leafId = node.attrs.id; });
    leafId ??= movingId;
    const sharedText = tree.content(leafId).get(0) as Y.XmlText;
    (peerTree.content(leafId).get(0) as Y.XmlText).insert(0, 'Peer ');
    tree.move({ blockId: movingId, parentId: null, beforeId: null, operationId: 'concurrent-move' }, 'benchmark-move');
    const leftUpdate = Y.encodeStateAsUpdate(doc);
    const rightUpdate = Y.encodeStateAsUpdate(peer);
    Y.applyUpdate(doc, rightUpdate); Y.applyUpdate(peer, leftUpdate);
    const final = tree.read();
    assert.equal(tree.content(leafId).get(0), sharedText, 'moves keep the original integrated text object');
    assert.equal(identityContents(final).get(leafId), `Peer ${initialContents.get(leafId)}`);
    assert.deepEqual(final.toJSON(), peerTree.read().toJSON());
    const bytes = Y.encodeStateAsUpdate(doc);
    const validationStarted = performance.now();
    const validation = validateRichMarkdownYDoc(doc);
    const validationMs = performance.now() - validationStarted;
    assert.equal(validation.valid, true, `large fixture must remain checkpointable: ${validation.code}`);
    assert.deepEqual(Y.encodeStateAsUpdate(doc), bytes, 'validation must not rewrite the benchmark fixture');
    Y.applyUpdate(restored, bytes);
    assert.deepEqual(new CollaborationBlockTree(restored, schema).read().toJSON(), final.toJSON());
    return { name: spec.name, blocks: tree.records.size, historyBefore: spec.history,
      historyAfter: tree.operations.size, bytesBefore, bytesAfter: bytes.byteLength,
      project, read, referenceCold, referenceWarm, move, validationMs };
  } finally { doc.destroy(); peer.destroy(); restored.destroy(); }
}

const results = cases.map(runCase);
const report = {
  schemaVersion: 1, measuredAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  method: { samples, warmups, referenceWarmBatch: 10_000, units: 'milliseconds',
    scope: 'In-process Yjs/ProseMirror CPU work; no DOM, network, database, browser frame or end-to-end drop timing.',
    history: 'Deterministic persisted alternating moves, initialized outside timed samples; each measured move uses the production API.',
    validation: 'One complete checkpoint validation per case; no performance pass/fail threshold.' },
  results,
};
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const output = process.argv[outputIndex + 1];
  assert(output, '--output requires a path');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.table(results.map(row => ({ name: row.name, blocks: row.blocks, history: row.historyBefore,
  projectP50: row.project.p50Ms.toFixed(2), readP50: row.read.p50Ms.toFixed(2), moveP95: row.move.p95Ms.toFixed(2),
  targetColdP95: row.referenceCold.p95Ms.toFixed(2), targetWarmUs: (row.referenceWarm.p50Ms * 1000).toFixed(3),
  binaryKiB: (row.bytesAfter / 1024).toFixed(1) })));
