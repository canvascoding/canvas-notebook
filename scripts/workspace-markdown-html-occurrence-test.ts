import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { evaluateWorkspaceHtmlLinks, hasUnevaluatedWorkspaceHtmlLinks, inspectWorkspaceStaticHtmlLinks }
  from '../app/lib/markdown/workspace-html-link-safety';
import { inspectWorkspaceMarkdownHtmlV4, parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3 }
  from '../app/lib/markdown/workspace-local-link-parser';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';

// Syntax facts only: no FS, SQL, native state, principal, operation assessment or
// execution-readiness evidence is supplied by this suite.
export function workspaceMarkdownHtmlOccurrenceTest(): void {
  let passed = 0;
  const inspected = (html: string, fullyInspected: boolean, explicitLocalTargets: string[]) => {
    assert.deepEqual(inspectWorkspaceStaticHtmlLinks(html), { inspectionVersion: 1, fullyInspected, explicitLocalTargets }, html);
  };

  // 1. The historical optional-field contract is unchanged; the new API makes
  // an empty target list and incomplete inspection independently observable.
  for (const html of ['', '<div class="note">Static text</div>', '<img src="https://example.test/image.png">',
    '<a href="#section">Section</a>', '<!-- <img src="literal.png"> -->']) {
    inspected(html, true, []);
    assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: false });
    assert.equal(hasUnevaluatedWorkspaceHtmlLinks(html), false);
  }
  for (const html of ['<custom-element resource="asset.png"></custom-element>', '<div data-resource="asset.png">Text</div>',
    '</custom-element>', '</script>']) {
    inspected(html, false, []);
    assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: false }, 'Legacy false never implied complete inspection');
  }
  passed++;

  // 2. Exact, once-decoded targets retain order and duplicates.
  const decoded = '<div><img src="assets/a&amp;b.png"><a href="Notes/Plan%23Final.md#Section">Plan</a>'
    + '<img src="assets/a%252Fb.png"><img src="assets/a&amp;b.png"></div>';
  const targets = ['assets/a&b.png', 'Notes/Plan#Final.md', 'assets/a%2Fb.png', 'assets/a&b.png'];
  inspected(decoded, true, targets);
  assert.deepEqual(evaluateWorkspaceHtmlLinks(decoded), { unevaluated: true, explicitLocalTargets: targets });
  inspected('<IMG SRC="../Bild%201.png#Ansicht" width="320">', true, ['../Bild 1.png']);
  inspected('<img src="a&#65;b.png"><img src="a&#x41;b.png">', true, ['aAb.png', 'aAb.png']);
  passed++;

  // 3. Partial targets remain observable, but never acquire legacy certification.
  for (const suffix of ['<custom-element resource="hidden.png"></custom-element>', '<video poster="hidden.png"></video>',
    '<script src="https://example.test/script.js"></script>', '<base href="../">',
    '<meta http-equiv="refresh" content="0; url=hidden.md">']) {
    inspected(`<img src="stable.png">${suffix}`, false, ['stable.png']);
    assert.deepEqual(evaluateWorkspaceHtmlLinks(`<img src="stable.png">${suffix}`), { unevaluated: true });
  }
  inspected('<img src="stable.png" custom-resource="hidden.png">', false, ['stable.png']);
  passed++;

  // 4. Events, dynamic CSS and unsupported URL attributes cannot hide behind a
  // valid src. Simple layout declarations retain the existing interpretation.
  for (const attribute of ['onerror="this.src=\'hidden.png\'"', 'srcset="hidden.png 2x"',
    'style="background:url(hidden.png)"', 'style="width:var(--asset)"',
    'style="background:u\\72l(hidden.png)"', 'style="--asset: hidden.png"']) {
    inspected(`<img src="stable.png" ${attribute}>`, false, ['stable.png']);
    assert.deepEqual(evaluateWorkspaceHtmlLinks(`<img src="stable.png" ${attribute}>`), { unevaluated: true });
  }
  inspected('<img src="stable.png" style="display:block;max-width:100%;height:auto;margin:0 auto">', true, ['stable.png']);
  passed++;

  // 5. Ambiguous encodings, whitespace, malformed attributes and parser errors
  // do not yield a fully inspected local path.
  for (const html of ['<img src="a&sol;b.png">', '<img src="a&amp.png">', '<img src="a%ZZ.png">',
    '<img src="a%00.png">', '<img src="a%5Cb.png">', '<img src="%2Fasset.png">',
    '<img src=" asset.png ">', '<img src="asset.png?size=1">', '<img src="asset%3Fsize.png">',
    '<img src="">', '<img src="asset.png" src="other.png">', '<img src="asset.png" alt="unterminated>']) {
    assert.equal(inspectWorkspaceStaticHtmlLinks(html).fullyInspected, false, html);
    assert.deepEqual(evaluateWorkspaceHtmlLinks(html), { unevaluated: true }, html);
  }
  passed++;

  // 6. Complete HTML AST occurrences include external-only, unknown, comments,
  // zero-target and duplicate occurrences; source ranges are never fabricated.
  const htmlNodes = ['<img src="asset.png">', '<custom-element resource="hidden.png"></custom-element>',
    '<img src="https://example.test/image.png">', '<div class="note">No targets</div>',
    '<!-- literal <img src="comment.png"> -->', '<img src="asset.png">'];
  const markdown = htmlNodes.join('\n\n');
  const observations = inspectWorkspaceMarkdownHtmlV4(markdown, 'Notes/Fixture.md');
  assert.equal(observations.parserVersion, 4);
  const expectedNodes = [htmlNodes[0], '<custom-element resource="hidden.png">', '</custom-element>', ...htmlNodes.slice(2)];
  assert.deepEqual(observations.occurrences.map(occurrence => occurrence.raw), expectedNodes);
  let cursor = 0;
  for (const [index, occurrence] of observations.occurrences.entries()) {
    const start = markdown.indexOf(expectedNodes[index], cursor);
    assert(start >= cursor);
    assert.equal(occurrence.sourcePath, 'Notes/Fixture.md');
    assert.equal(occurrence.start, start);
    assert.equal(occurrence.end, start + expectedNodes[index].length);
    assert.equal(markdown.slice(occurrence.start, occurrence.end), occurrence.raw);
    cursor = occurrence.end;
  }
  assert.deepEqual(observations.occurrences.map(occurrence => occurrence.fullyInspected), [true, false, false, true, true, true, true]);
  assert.deepEqual(observations.occurrences.map(occurrence => occurrence.explicitLocalTargets), [['asset.png'], [], [], [], [], [], ['asset.png']]);
  passed++;

  // 7. Inline opening/closing tags are separate actual AST nodes, not a synthetic
  // merged HTML element; ordinary text does not enter their original spans.
  const inline = '😀 Text <span class="note">inside</span> tail <img src="image.png">.';
  const inlineNodes = inspectWorkspaceMarkdownHtmlV4(inline, 'Inline.md').occurrences;
  assert.deepEqual(inlineNodes.map(occurrence => occurrence.raw), ['<span class="note">', '</span>', '<img src="image.png">']);
  for (const occurrence of inlineNodes) {
    assert.equal(occurrence.start, inline.indexOf(occurrence.raw));
    assert.equal(occurrence.end, occurrence.start + occurrence.raw.length);
    assert.equal(inline.slice(occurrence.start, occurrence.end), occurrence.raw);
  }
  passed++;

  // 8. Parser-3 BOM/CRLF/frontmatter offsets are original UTF-16 code units,
  // including supplementary Unicode before and within the actual HTML node.
  const visible = '<img src="assets/😀%20image.png">';
  for (const prefix of ['\uFEFF', '\uFEFF# 😀 Heading\r\n\r\n',
    '\uFEFF---\r\naliases: ["😀 Alias"]\r\nexample: \'<img src="frontmatter.png">\'\r\n---\r\n\r\n# 😀 Heading\r\n\r\n']) {
    const source = `${prefix}${visible}\r\n`;
    const result = inspectWorkspaceMarkdownHtmlV4(source, 'Unicode.md');
    assert.deepEqual(result.occurrences, [{ sourcePath: 'Unicode.md', start: prefix.length,
      end: prefix.length + visible.length, raw: visible, fullyInspected: true, explicitLocalTargets: ['assets/😀 image.png'] }]);
  }
  passed++;

  // 9. Actual code, escaped markup, Obsidian comments and Wiki target/alias
  // literals do not become HTML occurrences. No second HTML search is used.
  const hidden = ['`<img src="inline-code.png">`', '```html\n<img src="fenced.png">\n```',
    '    <img src="indented.png">', '\\<img src="escaped.png">',
    '%% <img src="comment.png"> %%', '[[Note|<img src="wiki-alias.png">]]',
    '![[<img src="wiki-target.png">]]', '[[<span>Literal</span>|Alias]]'];
  for (const source of hidden) assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(source, 'Literal.md').occurrences, [], source);
  const mixed = `${hidden.join('\n\n')}\n\n${visible}`;
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(mixed, 'Literal.md').occurrences.map(occurrence => occurrence.raw), [visible]);
  passed++;
  // 10. Historical Wiki diagnostics and parser-2 BOM offsets remain independent
  // facts; the new grammar must not manufacture occurrences to match old gaps.
  const wikiHtml = '[[Note|<img src="asset.png">]]';
  for (const parser of [parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3]) {
    assert.deepEqual(parser(wikiHtml, 'Wiki.md').unevaluated, [{ sourcePath: 'Wiki.md', raw: '<img src="asset.png">',
      reason: 'html', start: 7, htmlTargets: ['asset.png'] }]);
  }
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(wikiHtml, 'Wiki.md').occurrences, []);
  const bomHtml = '\uFEFF<img src="asset.png">';
  assert.deepEqual(parseWorkspaceLocalLinks(bomHtml, 'Bom.md').unevaluated, [{ sourcePath: 'Bom.md', raw: bomHtml.slice(0, -1),
    reason: 'html', start: 0 }]);
  assert.deepEqual(parseWorkspaceLocalLinksV3(bomHtml, 'Bom.md').unevaluated, [{ sourcePath: 'Bom.md', raw: bomHtml.slice(1),
    reason: 'html', start: 1, htmlTargets: ['asset.png'] }]);
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(bomHtml, 'Bom.md').occurrences, [{ sourcePath: 'Bom.md', start: 1,
    end: bomHtml.length, raw: bomHtml.slice(1), fullyInspected: true, explicitLocalTargets: ['asset.png'] }]);
  passed++;

  // 11. Pin a historical parser-2/parser-3 result and its exact JSON hash. New
  // inspection calls cannot alter either old API's shape, order or spans.
  const legacySource = '[Plan](Plan.md#Top)\n\n<img src="asset.png">';
  const legacyExpected = {
    links: [{ alias: null, embed: false, end: 19, fragment: 'Top', kind: 'markdown', raw: '[Plan](Plan.md#Top)',
      sourcePath: 'Notes/Fixture.md', start: 0, syntax: 'inline-link', targetEnd: 18, targetLiteral: 'Plan.md#Top',
      targetPathText: 'Plan.md', targetStart: 7, workspaceRootRelative: false }],
    unevaluated: [{ sourcePath: 'Notes/Fixture.md', raw: '<img src="asset.png">', reason: 'html', start: 21,
      htmlTargets: ['asset.png'] }],
  };
  for (const parser of [parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3]) {
    assert.deepEqual(parser(legacySource, 'Notes/Fixture.md'), legacyExpected);
    inspectWorkspaceMarkdownHtmlV4(legacySource, 'Notes/Fixture.md');
    const result = parser(legacySource, 'Notes/Fixture.md');
    assert.deepEqual(result, legacyExpected);
    assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'),
      'cbfa4828bdc09ebd08e171e7784d050b98c2d7a22beca032bd03eaa1f9fdae3d');
  }
  passed++;
  // 12. New entries bound actual UTF-8 bytes before AST/tokenizer allocation.
  // This non-ASCII source reaches the byte cap well below the code-unit cap.
  const prefix = '<!--😀', suffix = '-->';
  const fixedBytes = Buffer.byteLength(prefix + suffix);
  const boundary = prefix + 'é'.repeat(Math.floor((MAX_INDEXED_MARKDOWN_BYTES - fixedBytes) / 2))
    + 'x'.repeat((MAX_INDEXED_MARKDOWN_BYTES - fixedBytes) % 2) + suffix;
  assert.equal(Buffer.byteLength(boundary), MAX_INDEXED_MARKDOWN_BYTES);
  inspected(boundary, true, []);
  assert.equal(inspectWorkspaceMarkdownHtmlV4(boundary, 'Bound.md').occurrences.length, 1);
  assert.throws(() => inspectWorkspaceStaticHtmlLinks(boundary + 'é'), RangeError);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(boundary + 'é', 'Bound.md'), RangeError);
  const tooManyCodeUnits = 'x'.repeat(MAX_INDEXED_MARKDOWN_BYTES + 1);
  assert.throws(() => inspectWorkspaceStaticHtmlLinks(tooManyCodeUnits), RangeError);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(tooManyCodeUnits, 'Bound.md'), RangeError);
  passed++;

  // 13. Target/occurrence caps are checked before their output-array pushes,
  // including targets spread across different HTML AST occurrences.
  const image = '<img src="asset.png">';
  const atTargetLimit = image.repeat(20_000);
  assert.equal(inspectWorkspaceStaticHtmlLinks(atTargetLimit).explicitLocalTargets.length, 20_000);
  assert.throws(() => inspectWorkspaceStaticHtmlLinks(atTargetLimit + image), RangeError);
  assert.equal(evaluateWorkspaceHtmlLinks(atTargetLimit + image).explicitLocalTargets?.length, 20_001,
    'The legacy classifier does not inherit the new target cap');
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(`${atTargetLimit}\n\n${image}`, 'Bound.md'), RangeError);
  const externalNode = '<img src="https://example.test/image.png">';
  assert.equal(inspectWorkspaceMarkdownHtmlV4(Array(20_000).fill(externalNode).join('\n\n'), 'Bound.md').occurrences.length, 20_000);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(Array(20_001).fill(externalNode).join('\n\n'), 'Bound.md'), RangeError);
  for (const budget of [-1, 20_001, 0.5, Infinity, NaN]) assert.throws(() => inspectWorkspaceStaticHtmlLinks(image, budget), RangeError);
  inspected('<div>No targets</div>', true, []);
  assert.equal(inspectWorkspaceStaticHtmlLinks('<div>No targets</div>', 0).fullyInspected, true);
  assert.throws(() => inspectWorkspaceStaticHtmlLinks(image, 0), RangeError);
  passed++;

  // 14. All real AST children are inspected, including HTML inside Markdown
  // link/reference labels. Historical link extraction still stops at the label.
  const nested: Array<{ source: string; raw: string[]; complete: boolean[]; targets: string[][] }> = [
    { source: '😀 [<img src="asset.png">](Plan.md)', raw: ['<img src="asset.png">'], complete: [true], targets: [['asset.png']] },
    { source: '[<span class="note">Label</span>][ref]\n\n[ref]: Plan.md',
      raw: ['<span class="note">', '</span>'], complete: [true, true], targets: [[], []] },
    { source: '[<custom-element resource="hidden.png">Label</custom-element>](Plan.md)',
      raw: ['<custom-element resource="hidden.png">', '</custom-element>'], complete: [false, false], targets: [[], []] },
  ];
  for (const example of nested) {
    const before = [parseWorkspaceLocalLinks(example.source, 'Nested.md'), parseWorkspaceLocalLinksV3(example.source, 'Nested.md')];
    assert.deepEqual(before.map(value => value.unevaluated), [[], []]);
    const actual = inspectWorkspaceMarkdownHtmlV4(example.source, 'Nested.md').occurrences;
    assert.deepEqual(actual.map(occurrence => occurrence.raw), example.raw);
    assert.deepEqual(actual.map(occurrence => occurrence.fullyInspected), example.complete);
    assert.deepEqual(actual.map(occurrence => occurrence.explicitLocalTargets), example.targets);
    let after = 0;
    for (const [index, occurrence] of actual.entries()) {
      const start = example.source.indexOf(example.raw[index], after);
      assert(start >= after);
      assert.equal(occurrence.sourcePath, 'Nested.md');
      assert.equal(occurrence.start, start);
      assert.equal(occurrence.end, start + example.raw[index].length);
      assert.equal(example.source.slice(occurrence.start, occurrence.end), occurrence.raw);
      after = occurrence.end;
    }
    assert.deepEqual([parseWorkspaceLocalLinks(example.source, 'Nested.md'), parseWorkspaceLocalLinksV3(example.source, 'Nested.md')], before);
  }
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4('![<img src="literal-alt.png">](image.png)', 'Nested.md').occurrences, [],
    'Image alt text is a literal field, with no HTML AST child');
  passed++;

  // 15. A caller can narrow remaining workspace budgets, never enlarge them.
  // The returned syntax facts do not encode or change with those limits.
  const limitedSource = `${image}\n\n<div>No targets</div>`;
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(limitedSource, 'Limited.md', { maximumOccurrences: 2, maximumTargets: 1 }),
    inspectWorkspaceMarkdownHtmlV4(limitedSource, 'Limited.md'));
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(limitedSource, 'Limited.md', { maximumOccurrences: 1 }), RangeError);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(`${image}\n\n${image}`, 'Limited.md', { maximumTargets: 1 }), RangeError);
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4('No HTML', 'Limited.md', { maximumOccurrences: 0, maximumTargets: 0 }).occurrences, []);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(image, 'Limited.md', { maximumOccurrences: 0 }), RangeError);
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(image, 'Limited.md', { maximumTargets: 0 }), RangeError);
  assert.equal(inspectWorkspaceMarkdownHtmlV4('<div>No targets</div>', 'Limited.md', { maximumTargets: 0 }).occurrences.length, 1);
  for (const invalid of [-1, 20_001, 0.5, Infinity, NaN, null, false, '1']) {
    assert.throws(() => inspectWorkspaceMarkdownHtmlV4(image, 'Limited.md', { maximumOccurrences: invalid as never }), RangeError);
    assert.throws(() => inspectWorkspaceMarkdownHtmlV4(image, 'Limited.md', { maximumTargets: invalid as never }), RangeError);
  }
  for (const invalid of [null, [], false, 1, 'limits']) {
    assert.throws(() => inspectWorkspaceMarkdownHtmlV4(image, 'Limited.md', invalid as never), RangeError);
  }
  assert.throws(() => inspectWorkspaceMarkdownHtmlV4(boundary + 'é', 'Limited.md', { maximumOccurrences: 20_000, maximumTargets: 20_000 }), RangeError);
  passed++;
  assert.equal(passed, 15);
  console.log(JSON.stringify({ suite: 'workspace-markdown-html-occurrence', passed, syntaxFactsOnly: true }));
}
