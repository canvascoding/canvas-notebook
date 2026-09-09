import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Extensions } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import type { Marked } from 'canvas-markdown-parser';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { CANVAS_MARKDOWN_INDENTATION, CANVAS_MARKED_OPTIONS, createCanvasMarkedInstance } from '../app/lib/markdown/core/canvas-marked';
import { CanvasImage } from '../app/lib/markdown/core/image';
import { CanvasCallout, CanvasDetails, MarkdownFootnoteDefinition } from '../app/lib/markdown/canvas-rich-markdown-extensions';

const previousPatterns: Record<string, RegExp> = {
  canvasCallout: /^ {0,3}>[ \t]*\[!/mu,
  canvasDetails: /^<details(?:\s+open(?:=(?:"open"|'open'|open))?)?>[ \t]*$/mu,
  markdownFootnoteDefinition: /^\[\^[^\]\r\n]+\]:/mu,
  image: /^<img /mu,
  canvasListBoundary: /^ {0,3}<!-- canvas-list-boundary -->[ \t]*(?:\r?\n|$)/mu,
};

function blockHints() {
  const hints: { name: string; start: (source: string) => number | void }[] = [CanvasCallout, CanvasDetails, MarkdownFootnoteDefinition, CanvasImage].map(extension => {
    const start = extension.config.markdownTokenizer?.start;
    if (typeof start !== 'function') throw new Error(`Missing ${extension.name} start hint`);
    return { name: extension.name, start };
  });
  const marked = createCanvasMarkedInstance() as unknown as Marked;
  const boundary = marked.defaults.extensions?.startBlock?.[0];
  if (typeof boundary !== 'function') throw new Error('Missing registered list-boundary hint');
  hints.push({ name: 'canvasListBoundary', start: boundary });
  return hints;
}

function manager(previous: boolean) {
  const marked = createCanvasMarkedInstance();
  if (previous) {
    const blockStarts = (marked as unknown as Marked).defaults.extensions?.startBlock;
    assert.ok(blockStarts);
    blockStarts[0] = source => source.search(previousPatterns.canvasListBoundary);
  }
  const codecExtensions: Extensions = richMarkdownCodecExtensions();
  const extensions = codecExtensions.map(extension => {
    const pattern = previousPatterns[extension.name];
    if (!previous || !pattern) return extension;
    return extension.extend({ markdownTokenizer: { ...extension.config.markdownTokenizer!,
      start: (source: string) => source.search(pattern),
    } });
  });
  return new MarkdownManager({ extensions, indentation: CANVAS_MARKDOWN_INDENTATION,
    marked, markedOptions: CANVAS_MARKED_OPTIONS });
}

const markers = [
  '> [!note] Title', '>\t[!NOTE]+ Title', '> [!', '> ordinary quote',
  '<details>', '<details open>', '<details\nopen="open">', '<details\u2028open>',
  '<details open=\'open\'>', '<details open=open>', '<details closed>', '<DETAILS>', '<details> trailing',
  '[^1]: Note', '[^space label]: Text', '[^line\u2028break]: Note', '[^]: Invalid', '[^ref]',
  '<img src="image.png">', '<img ', '<img\tsrc="image.png">', '<IMG src="image.png">',
  '<!-- canvas-list-boundary -->', '<!-- canvas-list-boundary --> trailing',
];

test('all registered block hints preserve exact indices at every suffix and line boundary', (t) => {
  const hints = blockHints();
  let comparisons = 0;
  for (const marker of markers) {
    for (const indent of ['', ' ', '   ', '    ', '\t', '\u00a0']) {
      for (const lineEnd of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
        const source = `prose 😀 ${marker}${lineEnd}${indent}${marker}${lineEnd}\n${markers.join('\n')}`;
        for (let offset = 0; offset <= source.length; offset++) {
          const suffix = source.slice(offset);
          for (const { name, start } of hints) {
            assert.equal(start(suffix), suffix.search(previousPatterns[name]), `${name}, offset ${offset}, ${JSON.stringify({ marker, indent, lineEnd })}`);
            comparisons++;
          }
        }
      }
    }
  }
  assert.ok(comparisons > 1_000_000);
  t.diagnostic(`${comparisons} exact-index comparisons`);
});

test('mixed, nested, malformed and successive documents parse and serialize identically', () => {
  const before = manager(true);
  const after = manager(false);
  const blocks = [
    'Paragraph with **bold**, [^ref], <details> and a > sign.',
    '> [!note]+ A title\n> Content\n>\n> - [ ] Nested task',
    '<details open>\n<summary>Summary</summary>\n\n> [!tip] Nested\n> Body\n\n</details>',
    '[^ref]: A footnote\n    with continuation\n\nAnother paragraph',
    '<img src="image.png" alt="Alt" width="240">',
    '- Before\n\n<!-- canvas-list-boundary -->\n\n- After',
    '| A | B |\n| --- | --- |\n| > [!note] | [^ref] |',
    '```markdown\n<details>\n[^ref]: Note\n<!-- canvas-list-boundary -->\n```',
    ...markers,
  ];
  let cases = 0;
  for (const first of blocks) {
    for (const second of blocks) {
      const source = `${first}\n\n${second}\n\nParagraph at end`;
      const previous = before.parse(source);
      const current = after.parse(source);
      assert.deepEqual(current, previous, source);
      assert.equal(after.serialize(current), before.serialize(previous), source);
      cases++;
    }
  }
  assert.equal(cases, 1024);
});

test('ordinary paragraphs no longer run the five block-start regexes over every suffix', () => {
  const before = manager(true);
  const after = manager(false);
  const source = Array.from({ length: 400 }, (_, index) => `Paragraph ${index} with ordinary **bold** text.`).join('\n\n');
  const patterns = new Set(Object.values(previousPatterns).map(pattern => pattern.source));
  const measure = (parser: MarkdownManager) => {
    const original = RegExp.prototype.exec;
    let calls = 0;
    let characters = 0;
    try {
      RegExp.prototype.exec = function (this: RegExp, input: string) {
        // The actual list-boundary tokenizer shares its hint's pattern source,
        // but is anchored only at the current position (no multiline flag).
        if (this.multiline && patterns.has(this.source)) { calls++; characters += input.length; }
        return original.call(this, input);
      };
      return { document: parser.parse(source), get calls() { return calls; }, get characters() { return characters; } };
    } finally { RegExp.prototype.exec = original; }
  };
  const previous = measure(before);
  const current = measure(after);
  assert.deepEqual(current.document, previous.document);
  assert.ok(previous.calls >= 5 * 399);
  assert.ok(previous.characters > source.length * 900);
  assert.equal(current.calls, 0);
  console.log(JSON.stringify({ inputCharacters: source.length, previousCalls: previous.calls,
    previousRegexInputCharacters: previous.characters, currentCalls: current.calls }));
});
