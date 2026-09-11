import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { readAgentBlockStructure } from '../app/lib/collaboration/agent-block-structure';
import { applyAgentBlockEdit, prepareAgentBlockEdit, previewAgentBlockEdit } from '../app/lib/collaboration/agent-block-edits';

test('move preview uses checked before/after locations and does not alter content, guards, or live state', () => {
  const doc = createRichMarkdownYDoc('First\n\nSecond\n\nThird', 'tiptap_blocks');
  try {
    const [first] = readAgentBlockStructure(doc);
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: first.id,
      placementHash: first.placementHash, parentId: null, beforeId: null }]);
    const before = Y.encodeStateAsUpdate(doc);
    const minimal = previewAgentBlockEdit(doc, prepared);
    const shown = previewAgentBlockEdit(doc, prepared, { includeLocations: true });
    assert.equal(minimal.locations, undefined);
    assert.equal(shown.beforeText, minimal.beforeText); assert.equal(shown.afterText, minimal.afterText);
    assert.equal(shown.footprintHash, minimal.footprintHash); assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    assert.deepEqual(shown.locations!.before[0].position, [1]);
    assert.equal(shown.locations!.before[0].following!.text, 'Second');
    assert.deepEqual(shown.locations!.after[0].position, [3]);
    assert.equal(shown.locations!.after[0].following, null);
    const { reverse } = applyAgentBlockEdit(doc, prepared, 'test'); assert.ok(reverse);
    const reversed = previewAgentBlockEdit(doc, reverse, { includeLocations: true });
    assert.deepEqual(reversed.locations!.after[0].position, [1]);
    assert.equal(reversed.locations!.after[0].following!.text, 'Second');
  } finally { doc.destroy(); }
});

test('location excerpts explicitly mark truncation without truncating affected content', () => {
  const long = 'Long context '.repeat(30);
  const doc = createRichMarkdownYDoc(`Affected content\n\n${long}\n\nLast`, 'tiptap_blocks');
  try {
    const [first] = readAgentBlockStructure(doc);
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'move_block', blockId: first.id,
      placementHash: first.placementHash, parentId: null, beforeId: null }]);
    const shown = previewAgentBlockEdit(doc, prepared, { includeLocations: true });
    const following = shown.locations!.before[0].following!;
    assert.equal(following.text.length, 160); assert.equal(following.truncated, true);
    assert.match(shown.beforeText, /Affected content/u); assert.match(shown.afterText, /Affected content/u);
  } finally { doc.destroy(); }
});

test('nested formatting retains actual parent locations and before/after marks', () => {
  const doc = createRichMarkdownYDoc('- Text\n- Other', 'tiptap_blocks');
  try {
    const paragraph = readAgentBlockStructure(doc).find((entry) => entry.type === 'paragraph' && entry.text === 'Text')!;
    const prepared = prepareAgentBlockEdit(doc, [{ kind: 'format_text', blockId: paragraph.id,
      subtreeHash: paragraph.subtreeHash, from: 0, to: 4, mark: 'bold', enabled: true }]);
    const shown = previewAgentBlockEdit(doc, prepared, { includeLocations: true });
    assert.equal(shown.locations!.before[0].parent!.type, 'listItem');
    assert.deepEqual(shown.locations!.before[0].position, [1, 1, 1]);
    assert.doesNotMatch(shown.beforeText, /"bold"/u); assert.match(shown.afterText, /"bold"/u);
  } finally { doc.destroy(); }
});
