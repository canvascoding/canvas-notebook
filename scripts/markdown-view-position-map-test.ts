import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSchema, type JSONContent } from '@tiptap/core';

import { createMarkdownViewPositionMap } from '../app/lib/editor/markdown-view-position-map';
import { createRichMarkdownManager, richMarkdownCodecExtensions, serializeRichMarkdownBody } from '../app/lib/markdown/rich-markdown-codec';
import { splitMarkdownEditorDocument } from '../app/lib/markdown/editor-document';
import { LocalMarkdownDocument } from '../app/lib/editor/local-markdown-document';

function indexed(markdown: string, mode: 'metadata' | 'content' = 'metadata') {
  const rich = createRichMarkdownManager().parse(splitMarkdownEditorDocument(markdown, mode).body);
  let sequence = 0;
  const identify = (node: JSONContent) => {
    if (node.type !== 'text' && node.type !== 'doc') node.attrs = { ...node.attrs, id: `block-${++sequence}` };
    node.content?.forEach(identify);
  };
  identify(rich);
  const doc = getSchema(richMarkdownCodecExtensions()).nodeFromJSON(rich);
  return { map: createMarkdownViewPositionMap(markdown, mode, rich), rich, doc };
}

function allTextBlocksMapped(markdown: string) {
  const result = indexed(markdown);
  result.doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    const block = result.map.blocks.find(candidate => candidate.blockId === node.attrs.id);
    assert(block, `${node.type.name} at ${position} must have a source span`);
    assert.equal(block.richFrom, position);
    assert.equal(block.richTo, position + node.nodeSize);
    assert(block.textOffsets, `${node.type.name} at ${position} must have character boundaries`);
    assert.equal(block.textOffsets.length, node.content.size + 1);
    for (let offset = 0; offset <= node.content.size; offset++) {
      const source = result.map.richToSource(position + 1 + offset);
      assert.equal(source, block.textOffsets[offset]);
      // Rich->Source->Rich may choose the next character when adjacent syntax
      // shares a boundary; visible characters retain their source location.
      assert.equal(result.map.sourceToRich(source!), position + 1 + offset);
    }
  });
  return result;
}

test('same paragraph instances map independently through nested lists and quotes', () => {
  const markdown = 'same\n\n- same\n  - same\n  - same\n- same\n\n> same\n> \n> same\n';
  const { map } = allTextBlocksMapped(markdown);
  const sourceStarts = [...markdown.matchAll(/same/gu)].map(match => match.index);
  const paragraphs = map.blocks.filter(block => block.type === 'paragraph');
  assert.equal(paragraphs.length, sourceStarts.length);
  assert.deepEqual(paragraphs.map(block => block.textOffsets![0]), sourceStarts);
  assert.equal(new Set(paragraphs.map(block => map.sourceToRich(block.textOffsets![0]))).size, sourceStarts.length);
});

test('frontmatter, CRLF, emoji and Markdown inline syntax retain full source coordinates', () => {
  const markdown = '---\r\ntitle: Test\r\n---\r\n\r\n# Heading\r\n\r\n😀 A &amp; **bold** [label](https://example.com) `code`\\* last\r\n';
  const { map } = allTextBlocksMapped(markdown);
  assert.equal(map.sourceLength, markdown.length);
  assert.equal(map.bodyOffset, markdown.indexOf('# Heading'));
  const paragraph = map.blocks.find(block => block.type === 'paragraph')!;
  for (const word of ['bold', 'label', 'code', 'last']) {
    const source = markdown.indexOf(word);
    const richPosition = map.sourceToRich(source)!;
    assert.equal(map.richToSource(richPosition), source);
  }
  assert.equal(map.textToSource(paragraph.sourceFrom, 0), markdown.indexOf('😀'));
  const within = map.sourceToText(markdown.indexOf('label') + 2)!;
  assert.equal(map.textToSource(within.sourceFrom, within.textOffset), markdown.indexOf('label') + 2);
  assert.equal(map.sourceToRich(0), map.blocks[0].richFrom! + 1, 'metadata falls back to the first visible body block');
});

test('task and mixed nested lists keep exact paragraph offsets and identities', () => {
  allTextBlocksMapped('- [ ] same\n  - [x] same\n  - nested\n- [x] last\n');
  allTextBlocksMapped('- ordinary\n- [x] checked\n- normal\n');
  allTextBlocksMapped('3. same\n   1. nested\n   2. again\n4. last\n');
});

test('a task list after a footnote owns both physical items with LF and CRLF', () => {
  for (const ending of ['\n', '\r\n']) {
    const markdown = '\uFEFF' + ['---', 'title: Metadata', '---', '', 'Before[^second]', '',
      '[^second]: Second note', '', '- [ ] task', '- [x] another', '', 'After'].join(ending);
    const { map } = allTextBlocksMapped(markdown);
    const list = map.blocks.find(block => block.type === 'taskList')!;
    assert.equal(list.sourceFrom, markdown.indexOf('- [ ] task'));
    assert.ok(list.sourceTo >= markdown.indexOf('another') + 'another'.length);
    const paragraphs = map.blocks.filter(block => block.type === 'paragraph' && block.sourceFrom >= list.sourceFrom && block.sourceTo <= list.sourceTo);
    assert.equal(paragraphs.length, 2);
    assert.deepEqual(paragraphs.map(block => block.textOffsets![0]), [markdown.indexOf('task'), markdown.indexOf('another')]);
  }
});

test('tables preserve cells, escaped pipes, multiple paragraphs and inline code', () => {
  const markdown = '| Same | Same |\n| --- | --- |\n| first<br><br>second | a\\|b |\n| `same` | same |\n';
  const { map } = allTextBlocksMapped(markdown);
  const second = markdown.indexOf('second');
  assert.equal(map.richToSource(map.sourceToRich(second)! + 2), second + 2);
  const pipe = markdown.indexOf('a\\|b') + 2;
  assert.equal(map.richToSource(map.sourceToRich(pipe)!), pipe);
});

test('fences, callouts, details and footnotes map their actual rich leaf blocks', () => {
  allTextBlocksMapped('```ts\nline one\nline two\n```\n\n> [!note] Title\n> same\n> \n> again\n\n<details>\n<summary>Summary</summary>\n\nsame\n\nagain\n\n</details>\n\n[^1]: Note\n    Again\n');
});

test('images and inline atoms occupy their real rich node sizes', () => {
  const markdown = 'Before ![alt](image.png) after\n\n![other](second.png)\n\nFinal paragraph\n';
  const { map, doc } = indexed(markdown);
  const image = map.blocks.find(block => block.type === 'image')!;
  assert.equal(image.richTo! - image.richFrom!, 1);
  assert.equal(map.richToSource(image.richFrom!), markdown.indexOf('![other]'));
  assert.equal(map.sourceToRich(markdown.indexOf('Final')), doc.content.size - 'Final paragraph'.length - 1);
  allTextBlocksMapped('Before ![alt](image.png) after\n');
  allTextBlocksMapped('Before @{Name|user-id} middle [[File|Label]] end[^1]\n');
  allTextBlocksMapped('Before $x+y$ end\n');
  allTextBlocksMapped('Before <mark>same</mark> end\n');
});

test('blank rich paragraphs and prompt frontmatter-as-content are accounted for', () => {
  allTextBlocksMapped('\n\nA\n\n\n\nB\n\n');
  allTextBlocksMapped('&nbsp;\n\nAfter\n');
  const markdown = '---\ntitle: Text\n---\n\nAfter\n';
  const { map } = indexed(markdown, 'content');
  assert.equal(map.bodyOffset, 0);
  assert.equal(map.blocks[0].sourceFrom, 0);
});

test('a stale or unavailable rich projection never gets invented rich positions', () => {
  const markdown = '# Heading\n\nCurrent paragraph\n';
  const { rich } = indexed(markdown);
  rich.content![1].content![0].text = 'Older paragraph';
  const stale = createMarkdownViewPositionMap(markdown, 'metadata', rich);
  assert.equal(stale.sourceToRich(markdown.indexOf('Current')), null);
  assert.equal(stale.richToSource(1), null);
  assert.equal(stale.blockIdToSource('block-1'), null);
  assert.equal(stale.sourceToText(markdown.indexOf('paragraph'))?.sourceFrom, markdown.indexOf('Current'));
  const opaque = createMarkdownViewPositionMap(markdown, 'metadata', null);
  assert.equal(opaque.sourceToRich(0), null);
  assert.equal(opaque.textToSource(markdown.indexOf('Current'), 3), markdown.indexOf('Current') + 3);
});

test('typing and serialization may split adjacent text runs without losing rich positions', () => {
  const markdown = '# First\n\nBefore **bold text** and a [link](https://example.com).\n\nLast paragraph\n';
  const { rich, doc } = indexed(markdown);
  const paragraph = rich.content![1];
  const text = paragraph.content!.map(node => node.text ?? '').join('');
  paragraph.content = [{ type: 'text', text }];
  const map = createMarkdownViewPositionMap(markdown, 'metadata', rich);
  const block = map.blocks.find(candidate => candidate.blockId === paragraph.attrs!.id)!;
  assert.equal(block.richFrom, doc.child(0).nodeSize);
  assert.equal(map.sourceToRich(markdown.indexOf('bold')), block.richFrom! + 1 + text.indexOf('bold'));
  assert.equal(map.richToSource(block.richFrom! + 1 + text.indexOf('link')), markdown.indexOf('link'));
});

test('source edits, rich typing and history snapshots keep mappings after serialization', () => {
  const document = new LocalMarkdownDocument('# First\n\nOne **bold** paragraph.\n\nLast paragraph\n');
  const source = document.openView('source', () => true);
  const sourceSnapshot = document.getSnapshot();
  const sourceEdit = sourceSnapshot.markdown.replace('First', 'First source change');
  assert(source.changeSource({ revision: sourceSnapshot.revision, markdown: sourceEdit,
    beforeSelection: { anchor: 7, head: 7 }, afterSelection: { anchor: 21, head: 21 } }));
  const rich = document.openView('rich', () => true);
  assert(rich.history('undo'));
  assert(rich.history('redo'));
  const before = document.getSnapshot();
  const after = structuredClone(before.richDocument!);
  after.content![1].content!.push({ type: 'text', text: ' rich change' });
  const pmDoc = getSchema(richMarkdownCodecExtensions()).nodeFromJSON(before.richDocument!);
  const paragraphStart = pmDoc.child(0).nodeSize;
  const caret = paragraphStart + pmDoc.child(1).nodeSize - 1;
  assert(rich.changeRich({ revision: before.revision, before: before.richDocument!, after,
    beforeSelection: { type: 'text', anchor: caret, head: caret },
    afterSelection: { type: 'text', anchor: caret + 12, head: caret + 12 } }));
  const check = () => {
    const snapshot = document.getSnapshot();
    const map = createMarkdownViewPositionMap(snapshot.markdown, 'metadata', snapshot.richDocument);
    assert(map.blocks.every(block => block.richFrom !== null), 'history snapshot must retain a valid positional rich projection');
    assert.notEqual(map.richToSource(paragraphStart + 1), null);
  };
  check();
  assert(rich.history('undo'));
  check();
  assert(rich.history('redo'));
  check();
});

test('an editor-only trailing empty paragraph maps to EOF without invalidating earlier blocks', () => {
  const markdown = '# First\n\n## Last heading\n\n```text\nLast code\n```';
  const { rich, doc } = indexed(markdown);
  rich.content!.push({ type: 'paragraph', attrs: { id: 'editable-tail' } });
  const map = createMarkdownViewPositionMap(markdown, 'metadata', rich);
  assert.equal(map.sourceToRich(markdown.indexOf('Last heading')), doc.child(0).nodeSize + 1);
  assert.equal(map.richToSource(doc.child(0).nodeSize + 1), markdown.indexOf('Last heading'));
  const tail = map.blocks.find(block => block.blockId === 'editable-tail')!;
  assert.equal(tail.richFrom, doc.content.size);
  assert.equal(tail.sourceFrom, markdown.length);
  assert.equal(map.richToSource(tail.richFrom! + 1), markdown.length);
  assert.equal(map.sourceToRich(markdown.length), tail.richFrom! + 1);
  rich.content!.at(-1)!.content = [{ type: 'text', text: 'Unsaved different text' }];
  assert.equal(createMarkdownViewPositionMap(markdown, 'metadata', rich).sourceToRich(0), null,
    'only genuinely empty editor-only tail blocks are compatible');
});

test('normalized wrapped paragraphs retain character maps for Canvas numeric whitespace entities', () => {
  const sentence = 'Its lines wrap differently in reading, formatted editing, and source views. ';
  const original = '# Before\n\nSection 31 has a uniquely identifiable paragraph with **bold text** and a [link](https://example.com). '
    + sentence.repeat(4) + '\n\n# After';
  const markdown = serializeRichMarkdownBody(original);
  assert(markdown.includes('&#32;'), 'fixture must contain the numeric whitespace escape emitted by Canvas');
  const { map } = allTextBlocksMapped(markdown);
  const paragraph = map.blocks.find(block => block.type === 'paragraph')!;
  const rendered = 'Section 31 has a uniquely identifiable paragraph with bold text and a link. ' + sentence.repeat(4);
  for (const character of [115, 182, rendered.length - 1]) {
    const source = map.textToSource(paragraph.sourceFrom, character);
    assert.notEqual(source, null, 'wrapped paragraphs with a numeric escape must retain interior coordinates');
    assert.equal(map.sourceToText(source!)!.sourceFrom, paragraph.sourceFrom);
    assert.equal(map.sourceToText(source!)!.textOffset, character);
  }
});
