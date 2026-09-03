import assert from 'node:assert/strict';

import type { Editor as TiptapEditor } from '@tiptap/core';
import { JSDOM } from 'jsdom';

import {
  clampEditorRangeToDoc,
  getSlashCommandDeletionRange,
  isEditorRangeInsideDoc,
} from '../app/lib/editor/prosemirror-ranges';
import {
  getMarkdownSourceModeReason,
  getRunawaySlashContentMessage,
  getTextEditorPerformanceProfile,
} from '../app/lib/editor/text-editor-guards';
import {
  createMarkdownHeadingAnchorFactory,
  markdownHeadingAnchorBase,
  scrollToMarkdownHeadingAnchor,
} from '../app/lib/markdown/heading-anchor';
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

Object.defineProperty(globalThis, 'DataTransfer', {
  configurable: true,
  value: class MockDataTransfer {
    private readonly values = new Map<string, string>();

    getData(type: string) {
      return this.values.get(type) ?? '';
    }

    setData(type: string, value: string) {
      this.values.set(type, value);
    }
  },
});

Object.defineProperty(globalThis, 'ClipboardEvent', {
  configurable: true,
  value: class MockClipboardEvent extends dom.window.Event {
    readonly clipboardData: DataTransfer | null;

    constructor(type: string, init?: { clipboardData?: DataTransfer }) {
      super(type);
      this.clipboardData = init?.clipboardData ?? null;
    }
  },
});

type JsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string }>;
  content?: JsonNode[];
};

function collectNodeTypes(node: JsonNode): string[] {
  return [
    ...(node.type ? [node.type] : []),
    ...(node.content ?? []).flatMap(collectNodeTypes),
  ];
}

function collectMarkTypes(node: JsonNode): string[] {
  return [
    ...(node.marks ?? []).flatMap((mark) => mark.type ? [mark.type] : []),
    ...(node.content ?? []).flatMap(collectMarkTypes),
  ];
}

function collectTableAlignments(node: JsonNode): string[] {
  return [
    ...(typeof node.attrs?.align === 'string' ? [node.attrs.align] : []),
    ...(node.content ?? []).flatMap(collectTableAlignments),
  ];
}

function collectTableCellContentTypes(node: JsonNode): string[] {
  return [
    ...(node.type === 'tableCell' || node.type === 'tableHeader'
      ? [node.content?.[0]?.type ?? 'missing']
      : []),
    ...(node.content ?? []).flatMap(collectTableCellContentTypes),
  ];
}

function findEmptyTableCellTextPosition(editor: TiptapEditor): number | null {
  let found: number | null = null;

  editor.state.doc.descendants((node, position) => {
    if (found !== null) return false;
    if (
      (node.type.name === 'tableCell' || node.type.name === 'tableHeader')
      && node.textContent === ''
      && node.firstChild?.type.name === 'paragraph'
    ) {
      found = position + 2;
      return false;
    }

    return true;
  });

  return found;
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

Workspace links [[Plan#Outcome|the plan]] and ![[Embed]], with a note.^[Inline source]

Workspace member @{Ada Lovelace|user-ada} owns the next step.

Highlighted ==important **context**== stays editable.

> [!warning]+ Verify this
> Callout body with *formatting*.

Reference with a standard footnote.[^1]

[^1]: Standard footnote content.

<details>
<summary>More context</summary>

Hidden **details** body.

</details>

<details open>
<summary>Initially visible</summary>

This details block stays open.

</details>

Inline math $E = mc^2$ remains in the paragraph.

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

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
  const repeatedBackslashLine = '\\'.repeat(240);
  const denseBackslashBlock = Array.from({ length: 8 }, () => '\\'.repeat(56)).join('\n');
  assert.equal(
    getMarkdownSourceModeReason(`# Normal\n\n${repeatedBackslashLine}`),
    'slash-runaway',
    'Markdown editor should avoid rich mode for repeated slash/backslash runaway content',
  );
  assert.match(
    getRunawaySlashContentMessage(`Intro\n${denseBackslashBlock}`) ?? '',
    /slash-dominated lines/,
    'Agent file validation should flag slash/backslash-dominated line blocks',
  );
  assert.equal(
    getTextEditorPerformanceProfile(`const x = "${'/'.repeat(12_000)}";`).disableLineWrapping,
    true,
    'CodeMirror should disable line wrapping for extremely long lines',
  );

  const { Editor } = await import('@tiptap/core');
  const { StarterKit } = await import('@tiptap/starter-kit');
  const { Markdown } = await import('@tiptap/markdown');
  const { Link } = await import('@tiptap/extension-link');
  const { Mathematics } = await import('@tiptap/extension-mathematics');
  const { Image } = await import('@tiptap/extension-image');
  const { TaskList } = await import('@tiptap/extension-task-list');
  const { TaskItem } = await import('@tiptap/extension-task-item');
  const { TableKit } = await import('@tiptap/extension-table');
  const { MarkdownHeadingAnchors } = await import('../app/lib/markdown/tiptap-heading-anchors');
  const { canvasRichMarkdownExtensions } = await import('../app/lib/markdown/canvas-rich-markdown-extensions');
  const {
    createObsidianWikiLinkExtensions,
    createObsidianWikiLinkNode,
  } = await import('../app/components/editor/ObsidianWikiLinkExtension');
  const { ObsidianInlineFootnoteExtension } = await import('../app/components/editor/ObsidianInlineFootnoteExtension');
  const { getActiveWorkspaceWikiLink } = await import('../app/lib/markdown/tiptap-workspace-link');

  const editor = new Editor({
    content: sampleMarkdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({ link: false, paragraph: false, blockquote: false }),
      Link.configure({ openOnClick: false }),
      Mathematics.configure({
        katexOptions: {
          maxExpand: 1_000,
          maxSize: 20,
          strict: 'warn',
          throwOnError: false,
          trust: false,
        },
      }),
      Image,
      TaskList,
      TaskItem.configure({
        HTMLAttributes: {
          'data-type': 'taskItem',
        },
        nested: true,
      }),
      TableKit.configure({ table: { resizable: false } }),
      MarkdownHeadingAnchors,
      ...canvasRichMarkdownExtensions({
        obsidianWikiLink: createObsidianWikiLinkNode(),
      }),
      ...createObsidianWikiLinkExtensions({
        labels: { empty: 'No match', group: 'Workspace links' },
        workspaceId: null,
      }),
      ObsidianInlineFootnoteExtension,
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
  const markTypes = collectMarkTypes(json);
  const tableAlignments = collectTableAlignments(json);

  assert.equal(
    editor.schema.topNodeType.contentMatch.defaultType?.name,
    'paragraph',
    'paragraphs must remain the default block so empty containers never auto-fill with callouts',
  );

  assert.match(output, /^# Title/m);
  assert.match(output, /\*\*bold\*\*/);
  assert.match(output, /\*italic\*/);
  assert.match(output, /~~strike~~/);
  assert.match(output, /`code`/);
  assert.match(output, /\[link\]\(https:\/\/example\.com\)/);
  assert.match(output, /\[\[Plan#Outcome\|the plan\]\]/);
  assert.match(output, /!\[\[Embed\]\]/);
  assert.match(output, /\^\[Inline source\]/);
  assert.match(output, /@\{Ada Lovelace\|user-ada\}/u);
  assert.match(output, /==important \*\*context\*\*==/u);
  assert.match(output, /^> \[!warning\]\+ Verify this$/mu);
  assert.match(output, /^> Callout body with \*formatting\*\.$/mu);
  assert.match(output, /standard footnote\.\[\^1\]/u);
  assert.match(output, /^\[\^1\]: Standard footnote content\.$/mu);
  assert.match(output, /^<details>\n<summary>More context<\/summary>/mu);
  assert.match(output, /Hidden \*\*details\*\* body\./u);
  assert.match(output, /^<details open>\n<summary>Initially visible<\/summary>/mu);
  assert.match(output, /This details block stays open\./u);
  assert.match(output, /Inline math \$E = mc\^2\$/);
  assert.ok(output.includes(String.raw`$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$`));
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
  assert.equal(
    nodeTypes.filter((type) => type === 'obsidianWikiLink').length,
    2,
    'wiki links and embeds should parse into rich-editor nodes',
  );
  assert.ok(nodeTypes.includes('obsidianInlineFootnote'), 'inline footnotes should parse into rich-editor nodes');
  assert.ok(nodeTypes.includes('markdownMention'), 'workspace mentions should parse into stable rich-editor nodes');
  assert.ok(markTypes.includes('canvasHighlight'), 'Obsidian highlights should parse into editable marks');
  assert.ok(nodeTypes.includes('canvasCallout'), 'Obsidian callouts should parse into rich-editor blocks');
  assert.ok(nodeTypes.includes('canvasDetails'), 'details blocks should parse into rich-editor blocks');
  assert.ok(nodeTypes.includes('markdownFootnoteReference'), 'standard footnote references should remain editable');
  assert.ok(nodeTypes.includes('markdownFootnoteDefinition'), 'standard footnote definitions should remain editable');
  assert.ok(nodeTypes.includes('inlineMath'), 'inline LaTeX should parse as an editable math node');
  assert.ok(nodeTypes.includes('blockMath'), 'display LaTeX should parse as an editable math node');
  assert.ok(nodeTypes.includes('codeBlock'), 'Mermaid fences should remain code blocks');
  assert.ok(
    editor.view.dom.querySelector('li[data-type="taskItem"]'),
    'editable task item node views should keep the data-type attribute used by editor CSS',
  );
  assert.equal(
    editor.view.dom.querySelector('h1')?.id,
    'title',
    'rich-editor headings should expose document-local anchor IDs',
  );
  assert.equal(markdownHeadingAnchorBase('Einführung & Überblick'), 'einführung-überblick');
  const nextHeadingAnchor = createMarkdownHeadingAnchorFactory();
  assert.deepEqual(
    ['Topic', 'Topic', 'Topic 1'].map(nextHeadingAnchor),
    ['topic', 'topic-1', 'topic-1-1'],
    'generated heading anchors should remain unique even when a suffix resembles another heading',
  );
  let scrolledToHeading = false;
  const titleHeading = editor.view.dom.querySelector('h1');
  assert.ok(titleHeading, 'rich-editor heading should be rendered');
  Object.defineProperty(titleHeading, 'scrollIntoView', {
    configurable: true,
    value: () => {
      scrolledToHeading = true;
    },
  });
  assert.equal(scrollToMarkdownHeadingAnchor(editor.view.dom, '#title'), true);
  assert.equal(scrolledToHeading, true, 'document-local links should scroll to the matching rich-editor heading');

  const wikiLinkCountBeforePaste = nodeTypes.filter((type) => type === 'obsidianWikiLink').length;
  editor.commands.insertContent(' [[Pasted/Document|Pasted title]]', { applyPasteRules: true });
  const afterPasteNodeTypes = collectNodeTypes(editor.getJSON());
  assert.equal(
    afterPasteNodeTypes.filter((type) => type === 'obsidianWikiLink').length,
    wikiLinkCountBeforePaste + 1,
    'pasted wiki-link syntax should become a rich-editor node',
  );
  assert.match(editor.getMarkdown(), /\[\[Pasted\/Document\|Pasted title\]\]/u);

  const editableWikiLinkPosition = findDocNodePosition(editor, 'obsidianWikiLink');
  assert.notEqual(editableWikiLinkPosition, null);
  editor.commands.setNodeSelection(editableWikiLinkPosition ?? 0);
  const activeWorkspaceLink = getActiveWorkspaceWikiLink(editor);
  assert.equal(activeWorkspaceLink?.target, 'Pasted/Document');
  assert.equal(activeWorkspaceLink?.text, 'Pasted title');
  assert.equal(activeWorkspaceLink?.displayText, 'Pasted title');
  assert.ok(editor.isActive('obsidianWikiLink'), 'the selected wiki link should be visible to toolbar state');

  editor.commands.insertContentAt(activeWorkspaceLink?.range ?? { from: 0, to: 0 }, {
    type: 'obsidianWikiLink',
    attrs: { embed: false, target: 'Projects/Revised|Revised plan' },
  });
  assert.match(editor.getMarkdown(), /\[\[Projects\/Revised\|Revised plan\]\]/u);

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

  const calloutCountBeforeBlankTable = collectNodeTypes(editor.getJSON())
    .filter((type) => type === 'canvasCallout').length;
  editor.commands.insertContentAt(editor.state.doc.content.size, { type: 'paragraph' });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  assert.equal(
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    true,
    'a blank table should be insertable',
  );
  const tableCellContentTypes = collectTableCellContentTypes(editor.getJSON());
  assert.ok(tableCellContentTypes.length >= 9, 'the inserted table should expose all editable cells');
  assert.ok(
    tableCellContentTypes.every((type) => type === 'paragraph'),
    'every table cell must start with an editable paragraph instead of a callout',
  );
  assert.equal(
    collectNodeTypes(editor.getJSON()).filter((type) => type === 'canvasCallout').length,
    calloutCountBeforeBlankTable,
    'inserting a table must not add phantom callouts to cells or the document',
  );
  const emptyCellPosition = findEmptyTableCellTextPosition(editor);
  assert.notEqual(emptyCellPosition, null, 'a blank table cell should expose a text cursor position');
  editor.commands.setTextSelection(emptyCellPosition ?? 0);
  editor.commands.insertContent('Editable cell');
  assert.ok(
    editor.state.doc.textContent.includes('Editable cell'),
    'users must be able to type into a newly inserted table cell',
  );
  const sourceModeMarkdown = editor.getMarkdown();
  assert.doesNotMatch(
    sourceModeMarkdown,
    /&gt; \\[!note\\] Note/u,
    'switching to Markdown source must not serialize phantom Note text into table cells',
  );
  assert.doesNotMatch(
    sourceModeMarkdown,
    /^> \[!note\] Note$/mu,
    'switching to Markdown source must not append a phantom Note block',
  );

  const calloutCountBeforeInsert = collectNodeTypes(editor.getJSON())
    .filter((type) => type === 'canvasCallout').length;
  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'paragraph',
    content: [{ type: 'text', text: 'callout insertion anchor' }],
  });
  const calloutAnchor = findDocTextPosition(editor, 'callout insertion anchor');
  assert.notEqual(calloutAnchor, null, 'callout insertion anchor should be discoverable');
  assert.equal(
    editor.commands.insertCanvasCallout({
      title: 'Dialog callout',
      type: 'info',
      content: 'Inserted callout body',
      range: {
        from: calloutAnchor ?? 0,
        to: (calloutAnchor ?? 0) + 'callout insertion anchor'.length,
      },
    }),
    true,
    'callouts should insert at an explicit stored range',
  );
  assert.equal(
    collectNodeTypes(editor.getJSON()).filter((type) => type === 'canvasCallout').length,
    calloutCountBeforeInsert + 1,
    'a callout command must create exactly one callout node',
  );
  assert.match(editor.getMarkdown(), /^> \[!info\] Dialog callout\n> Inserted callout body$/mu);

  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'paragraph',
    content: [{ type: 'text', text: 'details insertion anchor' }],
  });
  const detailsAnchor = findDocTextPosition(editor, 'details insertion anchor');
  assert.notEqual(detailsAnchor, null, 'details insertion anchor should be discoverable');
  assert.equal(
    editor.commands.insertCanvasDetails({
      summary: 'Dialog details',
      content: 'Inserted details body',
      open: true,
      range: {
        from: detailsAnchor ?? 0,
        to: (detailsAnchor ?? 0) + 'details insertion anchor'.length,
      },
    }),
    true,
    'details should insert at an explicit stored range',
  );
  assert.match(
    editor.getMarkdown(),
    /^<details open>\n<summary>Dialog details<\/summary>\n\nInserted details body\n\n<\/details>$/mu,
    'the open state of a collapsible section must survive Markdown serialization',
  );

  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'paragraph',
    content: [{ type: 'text', text: 'footnote insertion anchor' }],
  });
  const footnoteAnchor = findDocTextPosition(editor, 'footnote insertion anchor');
  assert.notEqual(footnoteAnchor, null, 'footnote insertion anchor should be discoverable');
  assert.equal(
    editor.commands.insertMarkdownFootnote({
      content: 'Inserted footnote definition',
      range: {
        from: footnoteAnchor ?? 0,
        to: (footnoteAnchor ?? 0) + 'footnote insertion anchor'.length,
      },
    }),
    true,
    'footnotes should insert their reference at the stored range',
  );
  const insertedFootnoteMarkdown = editor.getMarkdown();
  assert.match(insertedFootnoteMarkdown, /\[\^2\]/u, 'the new footnote should receive the next available reference number');
  assert.match(
    insertedFootnoteMarkdown,
    /^\[\^2\]: Inserted footnote definition$/mu,
    'the new footnote should append an editable definition exactly once',
  );

  editor.commands.insertContentAt(editor.state.doc.content.size, {
    type: 'paragraph',
    content: [{ type: 'text', text: 'formula insertion anchor' }],
  });
  const formulaAnchor = findDocTextPosition(editor, 'formula insertion anchor');
  assert.notEqual(formulaAnchor, null, 'formula insertion anchor should be discoverable');
  editor.chain().deleteRange({
    from: formulaAnchor ?? 0,
    to: (formulaAnchor ?? 0) + 'formula insertion anchor'.length,
  }).run();
  assert.equal(
    editor.chain().insertInlineMath({
      latex: 'x^2',
      pos: editor.state.selection.from,
    }).run(),
    true,
    'inline formulas should be inserted only after the prior deletion transaction has committed',
  );
  assert.match(editor.getMarkdown(), /\$x\^2\$/u);

  editor.commands.setContent('', {
    contentType: 'markdown',
    emitUpdate: false,
  });
  assert.deepEqual(
    editor.getJSON(),
    { type: 'doc', content: [{ type: 'paragraph' }] },
    'a blank Markdown document should start as an editable paragraph',
  );
  assert.equal(editor.getMarkdown(), '', 'a blank Markdown document should remain empty on disk');
  assert.doesNotMatch(
    editor.getMarkdown(),
    /> \[!note\]/u,
    'a blank Markdown document must not materialize a Note callout',
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

  const quoteEditor = new Editor({
    content: '<p></p>',
    extensions: editor.options.extensions,
  });
  assert.equal(quoteEditor.commands.toggleBlockquote(), true);
  quoteEditor.state.doc.check();
  assert.equal(quoteEditor.getMarkdown().trim(), '>');
  assert.equal(quoteEditor.commands.undo(), true);
  assert.equal(quoteEditor.isActive('blockquote'), false);
  assert.equal(quoteEditor.commands.redo(), true);
  assert.equal(quoteEditor.isActive('blockquote'), true);
  quoteEditor.commands.insertContent('Quote text');
  quoteEditor.commands.selectAll();
  quoteEditor.commands.deleteSelection();
  quoteEditor.state.doc.check();
  quoteEditor.commands.setContent('Before\n\n>\n\n## After', { contentType: 'markdown' });
  quoteEditor.state.doc.check();
  assert.equal(quoteEditor.getMarkdown().trim(), 'Before\n\n>\n\n## After');
  quoteEditor.destroy();

  editor.destroy();

  console.log('tiptap-markdown-roundtrip-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
