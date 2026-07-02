import assert from 'node:assert/strict';

import type { Editor as TiptapEditor } from '@tiptap/core';
import { JSDOM } from 'jsdom';

import {
  clampEditorRangeToDoc,
  getSlashCommandDeletionRange,
  isEditorRangeInsideDoc,
} from '../app/lib/editor/prosemirror-ranges';
import {
  CANVAS_BLOCK_DRAG_DATA_TYPE,
  getReorderableBlockRangeAt,
  hasCanvasBlockDragData,
  moveReorderableBlock,
  setCanvasBlockDragData,
} from '../app/lib/editor/reorderable-blocks';

const dom = new JSDOM('<!doctype html><html><body></body></html>');

for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: dom.window[key],
  });
}

type JsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
};

function collectNodeTypes(node: JsonNode): string[] {
  return [
    ...(node.type ? [node.type] : []),
    ...(node.content ?? []).flatMap(collectNodeTypes),
  ];
}

function collectTableAlignments(node: JsonNode): string[] {
  return [
    ...(typeof node.attrs?.align === 'string' ? [node.attrs.align] : []),
    ...(node.content ?? []).flatMap(collectTableAlignments),
  ];
}

function findDocTextPosition(editor: TiptapEditor, text: string): number | null {
  let found: number | null = null;

  editor.state.doc.descendants((node, position) => {
    if (found !== null) return false;
    if (node.isText && node.text?.includes(text)) {
      found = position;
      return false;
    }

    return true;
  });

  return found;
}

function findDocNodePosition(editor: TiptapEditor, typeName: string): number | null {
  let found: number | null = null;

  editor.state.doc.descendants((node, position) => {
    if (found !== null) return false;
    if (node.type.name === typeName) {
      found = position;
      return false;
    }

    return true;
  });

  return found;
}

function createMockDataTransfer(): DataTransfer {
  const values = new Map<string, string>();

  return {
    get types() {
      return Array.from(values.keys());
    },
    getData(type: string) {
      return values.get(type) ?? '';
    },
    setData(type: string, value: string) {
      values.set(type, value);
    },
  } as unknown as DataTransfer;
}

const sampleMarkdown = `# Title

Paragraph with **bold**, *italic*, ~~strike~~, \`code\`, emoji 😄, and [link](https://example.com). ![Link preview: example.com](https://cdn.example.com/og.png)

![Alt](images/pic.png)

> Quote

- Item
- [x] Done
- [ ] Todo

1. One
2. Two

| A | B |
| --- | --- |
| 1 | 2 |

| Left | Center | Right |
| :--- | :---: | ---: |
| L | C | R |

\`\`\`mermaid
graph LR
  A-->B
\`\`\`

---
`;

async function main() {
  const { Editor } = await import('@tiptap/core');
  const { StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('@tiptap/markdown');
  const { Link } = await import('@tiptap/extension-link');
  const { Image } = await import('@tiptap/extension-image');
  const { TaskList } = await import('@tiptap/extension-task-list');
  const { TaskItem } = await import('@tiptap/extension-task-item');
  const { TableKit } = await import('@tiptap/extension-table');

  const editor = new Editor({
    content: sampleMarkdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false }),
      Image,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Markdown.configure({
        markedOptions: {
          gfm: true,
          breaks: false,
        },
      }),
    ],
  });

  const output = editor.getMarkdown();
  const json = editor.getJSON();
  const nodeTypes = collectNodeTypes(json);
  const tableAlignments = collectTableAlignments(json);

  assert.match(output, /^# Title/m);
  assert.match(output, /\*\*bold\*\*/);
  assert.match(output, /\*italic\*/);
  assert.match(output, /~~strike~~/);
  assert.match(output, /`code`/);
  assert.match(output, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(output, /!\[Link preview: example\.com\]\(https:\/\/cdn\.example\.com\/og\.png\)/);
  assert.match(output, /!\[Alt\]\(images\/pic\.png\)/);
  assert.match(output, /^> Quote/m);
  assert.match(output, /^- Item/m);
  assert.match(output, /^- \[x\] Done/m);
  assert.match(output, /^- \[ \] Todo/m);
  assert.match(output, /^1\. One/m);
  assert.match(output, /^2\. Two/m);
  assert.match(output, /^\| A\s+\| B\s+\|/m);
  assert.match(output, /^\| Left\s+\| Center\s+\| Right\s+\|/m);
  assert.match(output, /^\| :---+\s+\| :---+:\s+\| ---+:\s+\|/m);
  assert.match(output, /^```mermaid\ngraph LR\n  A-->B\n```/m);
  assert.match(output, /^---$/m);

  assert.ok(nodeTypes.includes('bulletList'), 'mixed GFM lists should keep normal bullet items');
  assert.ok(nodeTypes.includes('taskList'), 'mixed GFM lists should keep task items');
  assert.ok(nodeTypes.includes('table'), 'GFM tables should parse as table nodes');
  assert.ok(tableAlignments.includes('left'), 'GFM table alignment should preserve left cells');
  assert.ok(tableAlignments.includes('center'), 'GFM table alignment should preserve center cells');
  assert.ok(tableAlignments.includes('right'), 'GFM table alignment should preserve right cells');
  assert.ok(nodeTypes.includes('image'), 'Markdown images should parse as image nodes');
  assert.ok(nodeTypes.includes('codeBlock'), 'Mermaid fences should remain code blocks');

  const imagePosition = findDocNodePosition(editor, 'image');
  const tablePosition = findDocNodePosition(editor, 'table');
  assert.notEqual(imagePosition, null, 'image node should be discoverable for block controls');
  assert.notEqual(tablePosition, null, 'table node should be discoverable for block controls');
  assert.equal(
    getReorderableBlockRangeAt(editor, imagePosition ?? 0)?.kind,
    'topLevel',
    'image nodes should drag as top-level blocks',
  );
  assert.equal(
    getReorderableBlockRangeAt(editor, tablePosition ?? 0)?.kind,
    'topLevel',
    'tables should drag as top-level blocks',
  );

  const smallEditor = new Editor({
    content: 'x',
    extensions: [StarterKit],
  });
  assert.equal(
    isEditorRangeInsideDoc(smallEditor, { from: 48, to: 48 }),
    false,
    'stale slash command ranges should be rejected before doc.resolve',
  );
  assert.deepEqual(
    clampEditorRangeToDoc(smallEditor, { from: 48, to: 48 }),
    { from: smallEditor.state.doc.content.size, to: smallEditor.state.doc.content.size },
    'stale insertion ranges should clamp to a valid document position',
  );
  assert.equal(
    getSlashCommandDeletionRange(smallEditor, { from: 1, to: 2 }),
    null,
    'slash command cleanup should not delete non-slash text from an otherwise valid stale range',
  );

  const slashEditor = new Editor({
    content: '/heading',
    extensions: [StarterKit],
  });
  assert.deepEqual(
    getSlashCommandDeletionRange(slashEditor, { from: 1, to: 9 }),
    { from: 1, to: 9 },
    'slash command cleanup should delete the active slash query range',
  );

  const blockEditor = new Editor({
    content: 'One\n\nTwo\n\nThree',
    contentType: 'markdown',
    extensions: [StarterKit, Markdown],
  });
  const firstBlockPosition = findDocTextPosition(blockEditor, 'One');
  assert.notEqual(firstBlockPosition, null, 'top-level block text should be discoverable');
  const firstBlock = getReorderableBlockRangeAt(blockEditor, firstBlockPosition ?? 0);
  assert.equal(firstBlock?.kind, 'topLevel', 'paragraphs should move as top-level blocks');
  assert.equal(
    firstBlock ? moveReorderableBlock(blockEditor, firstBlock, blockEditor.state.doc.content.size) : false,
    true,
    'top-level block reorder should move the block',
  );
  const reorderedBlocks = blockEditor.getMarkdown();
  assert.ok(
    reorderedBlocks.indexOf('Two') < reorderedBlocks.indexOf('Three') &&
      reorderedBlocks.indexOf('Three') < reorderedBlocks.indexOf('One'),
    'top-level block reorder should preserve content and order',
  );

  const listEditor = new Editor({
    content: '- A\n- B\n- C',
    contentType: 'markdown',
    extensions: [StarterKit, Markdown],
  });
  const firstListItemPosition = findDocTextPosition(listEditor, 'A');
  const secondListItemPosition = findDocTextPosition(listEditor, 'B');
  assert.notEqual(firstListItemPosition, null, 'first list item text should be discoverable');
  assert.notEqual(secondListItemPosition, null, 'second list item text should be discoverable');
  const firstListItem = getReorderableBlockRangeAt(listEditor, firstListItemPosition ?? 0);
  const secondListItem = getReorderableBlockRangeAt(listEditor, secondListItemPosition ?? 0);
  assert.equal(secondListItem?.kind, 'listItem', 'list items should move as list item blocks');
  assert.equal(
    firstListItem && secondListItem ? moveReorderableBlock(listEditor, secondListItem, firstListItem.from) : false,
    true,
    'list item reorder should move the item inside the list',
  );
  const reorderedList = listEditor.getMarkdown();
  assert.ok(
    reorderedList.indexOf('- B') < reorderedList.indexOf('- A') &&
      reorderedList.indexOf('- A') < reorderedList.indexOf('- C'),
    'list item reorder should preserve list markdown order',
  );

  const blockDragData = createMockDataTransfer();
  assert.equal(hasCanvasBlockDragData(blockDragData), false, 'fresh drag data should not look like a block drag');
  setCanvasBlockDragData(blockDragData);
  assert.equal(hasCanvasBlockDragData(blockDragData), true, 'block drag data should be identifiable by custom MIME');
  assert.equal(blockDragData.getData(CANVAS_BLOCK_DRAG_DATA_TYPE), 'move', 'block drag should set the internal MIME payload');
  assert.equal(blockDragData.getData('text/plain'), '', 'block drag should not expose insertable plain text');

  listEditor.destroy();
  blockEditor.destroy();
  slashEditor.destroy();
  smallEditor.destroy();
  editor.destroy();

  console.log('tiptap-markdown-roundtrip-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
