import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownManager } from '@tiptap/markdown';
import type { Extensions, MarkdownTokenizer } from '@tiptap/core';
import { OrderedList, TaskList } from '@tiptap/extension-list';
import { Table } from '@tiptap/extension-table';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CANVAS_MARKDOWN_INDENTATION, CANVAS_MARKED_OPTIONS, createCanvasMarkedInstance } from '../app/lib/markdown/core/canvas-marked';
import { CanvasTable } from '../app/lib/markdown/core/lists-and-tables';

function manager(previous: boolean) {
  const codecExtensions: Extensions = richMarkdownCodecExtensions();
  const extensions = codecExtensions.map(extension => {
    if (!previous) return extension;
    if (extension.name === 'orderedList') return extension.extend({ markdownTokenizer: {
      ...OrderedList.config.markdownTokenizer!, name: 'canvasOrderedList',
      tokenize(source, tokens, lexer) {
        // Previous Canvas behavior: numeric markers defer to GFM; the upstream
        // tokenizer handles other markers and rejects ordinary paragraphs.
        if (/^\s*\d+[.)]\s/u.test(source)) return undefined;
        return OrderedList.config.markdownTokenizer?.tokenize(source, tokens, lexer);
      },
    } satisfies MarkdownTokenizer });
    if (extension.name === 'taskList') return extension.extend({ markdownTokenizer: TaskList.config.markdownTokenizer });
    if (extension.name === 'tableKit') return extension.extend({
      addExtensions() {
        return (this.parent?.() ?? []).map(child => child.name === 'table'
          ? child.extend({ markdownTokenizer: Table.config.markdownTokenizer }) : child);
      },
    });
    return extension;
  });
  return new MarkdownManager({ extensions, indentation: CANVAS_MARKDOWN_INDENTATION,
    marked: createCanvasMarkedInstance(), markedOptions: CANVAS_MARKED_OPTIONS });
}

test('list prefixes retain numeric, alphabetic, Roman, task, indentation and interruption semantics', () => {
  const before = manager(true);
  const after = manager(false);
  let cases = 0;
  for (const prefix of ['', ' ', '  ', '    ', '\t', '\n', '\r\n', '\u00a0']) {
    for (const marker of ['1.', '12)', 'a.', 'AA)', 'iii.', 'IV)', 'abc.', '-', '*', '+']) {
      for (const text of ['Item', '[ ] Task', '[x] Done', '[X] Done', '[?] Plain', '[ ]', '']) {
        const source = `${prefix}${marker} ${text}\n  continuation\n\nParagraph\n\n- [ ] Later task\n\n1. Later numeric list`;
        assert.deepEqual(after.parse(source), before.parse(source), JSON.stringify({ prefix, marker, text }));
        cases++;
      }
    }
  }
  assert.equal(cases, 560);
});

test('bounded table hints match the upstream hint including incomplete lines and long suffixes', () => {
  const original = Table.config.markdownTokenizer?.start;
  const optimized = CanvasTable.config.markdownTokenizer?.start;
  assert.equal(typeof original, 'function'); assert.equal(typeof optimized, 'function');
  if (typeof original !== 'function' || typeof optimized !== 'function') throw new Error('Adapt the table hint compatibility test');
  for (const first of ['', 'Header', '| A | B |', 'A | B', '`A|B` | C', 'A\\|B | C']) {
    for (const second of ['', '---', '| --- | --- |', '| :--- | ---: |', '| --- | x |', '  ---|---', '\t|---|']) {
      for (const ending of ['', '\n', '\r\n']) {
        const prefix = first + ending + second;
        for (const tail of ['', '\n', '\n\nParagraph\n'.repeat(100)]) {
          const source = prefix + tail;
          assert.equal(optimized(source), original(source), JSON.stringify({ first, second, ending, tail: tail.length }));
        }
      }
    }
  }
});

test('table pipes, mixed blocks and adjacent paragraphs retain the complete parsed document', () => {
  const before = manager(true);
  const after = manager(false);
  const blocks = [
    'Paragraph **with marks**.',
    '| Header | Second |\n| :--- | ---: |\n| a\\|b | `c|d` |',
    'Header | Second\n--- | ---\nA | B',
    '| Header | Second |\n| --- | --- |\n| A<br>B | C |',
    '- [ ] One\n  - [x] Nested\n- [X] Two',
    'a. Alpha\nb. Beta\n\nI. Roman\nII. Second',
    '> [!note]+ Title\n> Body\n>\n> - [ ] Quoted task',
    '<details>\n<summary>Title</summary>\n\n- [x] Nested\n\n</details>',
    'Text[^a]\n\n[^a]: Definition\n\n![alt](https://example.test/image.png)',
  ];
  for (const first of blocks) for (const second of blocks) {
    for (const separator of ['\n', '\n\n']) {
      const source = `${first}${separator}${second}`;
      assert.deepEqual(after.parse(source), before.parse(source), source);
    }
  }
});

test('ordinary paragraphs do not repeatedly split the whole remaining source into lines', context => {
  const source = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with **formatted text**.`).join('\n\n');
  const countLineSplits = (parser: MarkdownManager) => {
    const original = String.prototype.split;
    let scanned = 0;
    try {
      String.prototype.split = function (this: string, separator: unknown, limit?: number): string[] {
        if (separator === '\n') scanned += String(this).length;
        return Reflect.apply(original, this, [separator, limit]);
      };
      return { parsed: parser.parse(source), scanned };
    } finally { String.prototype.split = original; }
  };
  const before = countLineSplits(manager(true));
  const after = countLineSplits(manager(false));
  assert.deepEqual(after.parsed, before.parsed);
  assert(after.scanned < source.length * 20, `line splitting must remain proportional to input size: ${after.scanned}`);
  assert(before.scanned > after.scanned * 20, 'the original parser demonstrates the repeated whole-suffix scans');
  context.diagnostic(`Characters passed to line splitting: ${before.scanned} before, ${after.scanned} after (${source.length} input characters).`);
});
