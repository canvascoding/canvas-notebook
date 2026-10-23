import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { parseObsidianWikiTarget } from '../app/lib/markdown/obsidian-flavored-markdown';
import { inspectWorkspaceMarkdownHtmlV4, parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3,
  parseWorkspaceLocalLinksV4, type ParsedWorkspaceLocalLink } from '../app/lib/markdown/workspace-local-link-parser';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';

type Expected = Pick<ParsedWorkspaceLocalLink, 'raw' | 'targetLiteral' | 'targetPathText' | 'kind' | 'syntax'>
  & Partial<Pick<ParsedWorkspaceLocalLink, 'alias' | 'fragment' | 'embed' | 'workspaceRootRelative'>>;

/** Expectations use explicit original snippets, not parser-produced offsets.
 * Nested syntax ranges may overlap; their actual editable target ranges cannot. */
function expectedParser4Links(source: string, expected: Expected[], sourcePath = 'Notes/Source.md'): ParsedWorkspaceLocalLink[] {
  let cursor = 0;
  return expected.map(value => {
    const start = source.indexOf(value.raw, cursor);
    assert(start >= cursor, value.raw); cursor = start + 1;
    const targetOffset = value.kind === 'wiki'
      ? value.raw.indexOf(value.targetLiteral, value.raw.startsWith('!') ? 3 : 2)
      : value.raw.indexOf(']:') >= 0
        ? value.raw.indexOf(value.targetLiteral, value.raw.indexOf(']:') + 2)
        : value.raw.lastIndexOf(value.targetLiteral);
    assert(targetOffset >= 0, value.targetLiteral);
    return { alias: value.alias ?? null, embed: value.embed ?? false, end: start + value.raw.length,
      fragment: value.fragment ?? null, kind: value.kind, raw: value.raw, sourcePath, start,
      syntax: value.syntax, targetEnd: start + targetOffset + value.targetLiteral.length,
      targetLiteral: value.targetLiteral, targetPathText: value.targetPathText, targetStart: start + targetOffset,
      workspaceRootRelative: value.workspaceRootRelative ?? false };
  });
}

function checkParser4(source: string, expected: Expected[], sourcePath = 'Notes/Source.md'): ReturnType<typeof parseWorkspaceLocalLinksV4> {
  const before = source;
  const result = parseWorkspaceLocalLinksV4(source, sourcePath, { notebookPaths: 'exact' });
  assert.deepEqual(result.links, expectedParser4Links(source, expected, sourcePath));
  let end = 0;
  for (const link of result.links) {
    assert.equal(source.slice(link.start, link.end), link.raw);
    assert.equal(source.slice(link.targetStart, link.targetEnd), link.targetLiteral);
    assert(link.start <= link.targetStart && link.targetEnd <= link.end);
    assert(link.targetStart >= end, 'Ordinary editable target spans must not overlap'); end = link.targetEnd;
  }
  for (const gap of result.unevaluated) assert.equal(source.slice(gap.start, gap.start + gap.raw.length), gap.raw);
  assert.equal(source, before);
  return result;
}

export function workspaceLocalLinkParserV4Test(): void {
  let passed = 0;
  const wiki = (raw: string, targetLiteral: string, targetPathText: string, alias: string | null = null,
    fragment: string | null = null, embed = false): Expected => ({ raw, targetLiteral, targetPathText, alias, fragment,
    embed, kind: 'wiki', syntax: embed ? 'wiki-embed' : 'wiki-link' });
  const md = (raw: string, targetLiteral: string, targetPathText = targetLiteral,
    syntax: ParsedWorkspaceLocalLink['syntax'] = 'inline-link'): Expected => ({ raw, targetLiteral, targetPathText,
    syntax, kind: 'markdown', embed: syntax === 'inline-image' || syntax === 'reference-image' });

  // 1. A Wiki alias is literal even when CommonMark divides it into HTML nodes.
  for (const [raw, alias] of [['[[Note|<img src="asset.png">]]', '<img src="asset.png">'],
    ['[[Note|<custom-element resource="asset.png">Label</custom-element>]]', '<custom-element resource="asset.png">Label</custom-element>'],
    ['![[Note|<span>😀 Alias</span>]]', '<span>😀 Alias</span>']] as const) {
    const result = checkParser4(raw, [wiki(raw, 'Note', 'Note', alias, null, raw.startsWith('!'))]);
    assert.deepEqual(result.unevaluated, []);
    assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(raw, 'Notes/Source.md').occurrences, []);
  }
  passed++;

  // 2. An HTML-looking Wiki target is an actual literal path under the existing
  // Wiki parser. It never fabricates the src attribute as a separate file edge.
  for (const target of ['<img src="asset.png">', '<custom-element resource="asset.png">', 'Note|Part#Heading']) {
    const raw = `[[${target}|Alias]]`, actual = parseObsidianWikiTarget(`${target}|Alias`);
    assert(actual);
    const fragment = actual.heading ?? (actual.blockId ? `^${actual.blockId}` : null);
    const result = checkParser4(raw, [wiki(raw, actual.target, actual.path, actual.alias, fragment)]);
    assert.deepEqual(result.unevaluated, []);
    assert(!result.links.some(link => link.targetPathText === 'asset.png'));
  }
  passed++;

  // 3. Wiki priority keeps interior Markdown styling literal; an enclosing real
  // Markdown link retains its separate real target without overlapping edits.
  const literal = '[[Note|**Alias** and _emphasis_]]';
  assert.deepEqual(checkParser4(literal, [wiki(literal, 'Note', 'Note', '**Alias** and _emphasis_')]).unevaluated, []);
  const nested = '[Label [[Note|<img src="literal.png">]]](Outer.md)';
  const parsedNested = parseWorkspaceLocalLinksV4(nested, 'Nested.md');
  assert.deepEqual(parsedNested.links.map(link => [link.kind, link.targetPathText]), [['markdown', 'Outer.md'], ['wiki', 'Note']]);
  for (const link of parsedNested.links) {
    assert.equal(nested.slice(link.start, link.end), link.raw);
    assert.equal(nested.slice(link.targetStart, link.targetEnd), link.targetLiteral);
  }
  assert.deepEqual(parsedNested.unevaluated, []);
  const targetRanges = parsedNested.links.map(link => [link.targetStart, link.targetEnd]).sort((a, b) => a[0] - b[0]);
  assert(targetRanges[0][1] <= targetRanges[1][0]);
  passed++;

  // 4. HTML attributes, Markdown URL/title fields, image alt fields and actual
  // autolink URL display cannot manufacture Wiki references.
  for (const source of ['Before <span title="[[Fake]]">Label</span>', '<div title="[[Fake]]">Text</div>',
    '[Web](https://example.test/[[Fake]] "[[Title]]")', '![Alt [[Fake]]](image.png)',
    '<https://example.test/[[Fake]]>', '[Label](path-[[Fake]].md)', '[ref]: path-[[Fake]].md "[[Title]]"']) {
    const result = parseWorkspaceLocalLinksV4(source, 'Fields.md');
    assert(!result.links.some(link => link.kind === 'wiki'), source);
    for (const link of result.links) assert.equal(source.slice(link.targetStart, link.targetEnd), link.targetLiteral);
  }
  const boundary = '[[Note|<img title="]]">]]';
  const rejected = parseWorkspaceLocalLinksV4(boundary, 'Boundary.md');
  assert(!rejected.links.some(link => link.kind === 'wiki'));
  assert(rejected.unevaluated.some(gap => gap.reason === 'unparsed-target' && gap.start === 0));
  passed++;

  // 5. Actual Markdown targets keep their original syntax, reference cardinality,
  // fragments, escaped delimiters and exact notebook URL handling.
  const standard = ['[Inline](dir/plan.md#Part)', '![Image](<images/a b.png> "Image")',
    '[Ref][ref]', '![Ref image][image]', '[Shared][shared] ![Shared image][shared]',
    '[Angle][angle]', '', '[ref]: ref.md "Title"', '[image]: image.png',
    '[shared]: shared.md', '[angle]: <dir/angle note.md> "Title"', '',
    '[[Wiki/😀#Section|Label]] ![[image.png|Image]]', '[Exact](/notebook?path=%20note.md)'].join('\r\n');
  const standardExpected = [md('[Inline](dir/plan.md#Part)', 'dir/plan.md#Part', 'dir/plan.md'),
    md('![Image](<images/a b.png> "Image")', 'images/a b.png', 'images/a b.png', 'inline-image'),
    md('[ref]: ref.md "Title"', 'ref.md', 'ref.md', 'reference-link'),
    md('[image]: image.png', 'image.png', 'image.png', 'reference-image'),
    md('[shared]: shared.md', 'shared.md', 'shared.md', 'reference-definition'),
    md('[angle]: <dir/angle note.md> "Title"', 'dir/angle note.md', 'dir/angle note.md', 'reference-definition'),
    wiki('[[Wiki/😀#Section|Label]]', 'Wiki/😀#Section', 'Wiki/😀', 'Label', 'Section'),
    wiki('![[image.png|Image]]', 'image.png', 'image.png', 'Image', null, true),
    { ...md('[Exact](/notebook?path=%20note.md)', '/notebook?path=%20note.md', '/ note.md'), workspaceRootRelative: true }];
  standardExpected[0].fragment = 'Part';
  assert.deepEqual(checkParser4(standard, standardExpected).unevaluated, []);
  passed++;

  // 6. Markdown label HTML is still real HTML, not a literal Wiki alias. All
  // local or opaque HTML occurrences remain explicit diagnostics with true spans.
  for (const source of ['Before [<img src="asset.png">](Outer.md)',
    'Before [<custom-element resource="asset.png">Label</custom-element>](Outer.md)',
    'Before [<span data-resource="asset.png">Label</span>][ref]\n\n[ref]: Outer.md']) {
    const result = parseWorkspaceLocalLinksV4(source, 'Html.md');
    assert.equal(result.links.length, 1); assert.equal(result.links[0].targetPathText, 'Outer.md');
    assert(result.unevaluated.length > 0);
    for (const gap of result.unevaluated) {
      assert.equal(gap.reason, 'html'); assert.equal(source.slice(gap.start, gap.start + gap.raw.length), gap.raw);
      assert.equal(gap.start, source.indexOf(gap.raw));
    }
  }
  for (const html of ['<custom-element></custom-element>', '</custom-element>', '</script>',
    '<div data-resource="asset.png">Text</div>', '<img src="asset.png" onerror="run()">']) {
    const result = parseWorkspaceLocalLinksV4(html, 'Opaque.md');
    assert(result.unevaluated.some(gap => gap.reason === 'html' && !gap.htmlTargets), html);
  }
  for (const html of ['<div class="note">Text</div>', '<img src="https://example.test/image.png">', '<!-- no resource -->']) {
    assert.deepEqual(parseWorkspaceLocalLinksV4(html, 'Static.md'), { links: [], unevaluated: [] });
  }
  passed++;

  // 7. Original UTF-16 coordinates survive BOM, both newline styles, Unicode
  // frontmatter and all actual literal exclusions.
  for (const bom of ['', '\uFEFF']) for (const newline of ['\n', '\r\n']) {
    const prefix = bom + ['---', 'title: "😀 Front"', 'example: "[[Hidden]] <img src=\'hidden.png\'>"', '---', '',
      '# 😀 Heading', '', '`[[Code]] <img src="code.png">`', '', '```md', '[[Fence]]', '```', '',
      '    [[Indented]]', '', '%% [[Comment]] %%', '', '\\[[Escaped]]', '', '😀 before '].join(newline);
    const raw = '[[Note#^block|<img src="literal.png">]]';
    const source = `${prefix}${raw}${newline}${newline}[After](after.md)`;
    const result = checkParser4(source, [wiki(raw, 'Note#^block', 'Note', '<img src="literal.png">', '^block'), md('[After](after.md)', 'after.md')]);
    assert.deepEqual(result.unevaluated, []);
    assert.equal(result.links[0].start, prefix.length);
  }
  for (const source of ['\uFEFF[[Only]]', '\uFEFF\uFEFF[[Only]]']) {
    const result = checkParser4(source, [wiki('[[Only]]', 'Only', 'Only')]);
    assert.deepEqual(result.unevaluated, []);
  }
  passed++;

  // 8. Duplicate source syntax retains distinct original editable locations.
  const duplicate = '[[Note|<img src="literal.png">]]';
  const repeated = `${duplicate}\n\n${duplicate}\n\n[One](one.md)\n\n[One](one.md)`;
  const duplicates = checkParser4(repeated, [wiki(duplicate, 'Note', 'Note', '<img src="literal.png">'),
    wiki(duplicate, 'Note', 'Note', '<img src="literal.png">'), md('[One](one.md)', 'one.md'), md('[One](one.md)', 'one.md')]);
  assert.deepEqual(duplicates.unevaluated, []);
  assert.equal(new Set(duplicates.links.map(link => `${link.targetStart}:${link.targetEnd}`)).size, 4);
  passed++;

  // 9. Historical parser outputs and independent HTML occurrence facts remain
  // byte-identical. Parser 4 does not rewrite their grammar or global state.
  const legacySource = '[Plan](Plan.md#Top)\n\n<img src="asset.png">';
  const legacyExpected = {
    links: [{ alias: null, embed: false, end: 19, fragment: 'Top', kind: 'markdown', raw: '[Plan](Plan.md#Top)',
      sourcePath: 'Notes/Fixture.md', start: 0, syntax: 'inline-link', targetEnd: 18, targetLiteral: 'Plan.md#Top',
      targetPathText: 'Plan.md', targetStart: 7, workspaceRootRelative: false }],
    unevaluated: [{ sourcePath: 'Notes/Fixture.md', raw: '<img src="asset.png">', reason: 'html', start: 21,
      htmlTargets: ['asset.png'] }],
  };
  for (const parser of [parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3]) {
    const parsed = parser(legacySource, 'Notes/Fixture.md');
    assert.deepEqual(parsed, legacyExpected, 'Independent literal DTO, not Parser4 output, is the old-parser oracle');
    const before = JSON.stringify(parsed);
    assert.equal(createHash('sha256').update(before).digest('hex'), 'cbfa4828bdc09ebd08e171e7784d050b98c2d7a22beca032bd03eaa1f9fdae3d');
    parseWorkspaceLocalLinksV4(legacySource, 'Notes/Fixture.md');
    assert.equal(JSON.stringify(parser(legacySource, 'Notes/Fixture.md')), before);
    const wikiSource = '[[Note|<img src="asset.png">]]';
    assert.deepEqual(parser(wikiSource, 'Old.md').links, []);
    assert.deepEqual(parser(wikiSource, 'Old.md').unevaluated, [{ sourcePath: 'Old.md', raw: '<img src="asset.png">', reason: 'html',
      start: 7, htmlTargets: ['asset.png'] }]);
  }
  const htmlSource = 'Before [<img src="asset.png">](Outer.md)', htmlBefore = inspectWorkspaceMarkdownHtmlV4(htmlSource, 'Old.md');
  parseWorkspaceLocalLinksV4(htmlSource, 'Old.md');
  assert.deepEqual(inspectWorkspaceMarkdownHtmlV4(htmlSource, 'Old.md'), htmlBefore);
  passed++;

  // 10. The explicit new grammar is bounded; no legacy API acquires its limits.
  assert.throws(() => parseWorkspaceLocalLinksV4('😀'.repeat(Math.floor(MAX_INDEXED_MARKDOWN_BYTES / 4) + 1), 'Bound.md'), RangeError);
  assert.throws(() => parseWorkspaceLocalLinksV4('[[Note]] '.repeat(20_001), 'Bound.md'), RangeError);
  assert.throws(() => parseWorkspaceLocalLinksV4('[Note](note.md) '.repeat(20_001), 'Bound.md'), RangeError);
  passed++;

  // 11. A maximum-sized disjoint Wiki/HTML/text frontier exercises the actual
  // binary interval path. No machine-dependent elapsed-time assertion is used.
  const paragraphs = Array(20_000).fill('[[Note]]').join('\n\n');
  const paragraphResult = parseWorkspaceLocalLinksV4(paragraphs, 'Paragraphs.md');
  assert.equal(paragraphResult.links.length, 20_000);
  assert.deepEqual(paragraphResult.unevaluated, []);
  for (const link of paragraphResult.links) {
    assert.equal(link.targetPathText, 'Note');
    assert.equal(paragraphs.slice(link.start, link.end), '[[Note]]');
    assert.equal(paragraphs.slice(link.targetStart, link.targetEnd), 'Note');
  }
  const frontier = Array.from({ length: 20_000 }, (_, index) => `*Text* [[Note${index}|<span>Alias</span>]]`).join('\n\n');
  const frontierResult = parseWorkspaceLocalLinksV4(frontier, 'Frontier.md');
  assert.equal(frontierResult.links.length, 20_000);
  assert.deepEqual(frontierResult.unevaluated, []);
  for (const [index, link] of frontierResult.links.entries()) {
    assert.equal(link.targetPathText, `Note${index}`);
    assert.equal(frontier.slice(link.start, link.end), link.raw);
    assert.equal(frontier.slice(link.targetStart, link.targetEnd), link.targetLiteral);
  }
  passed++;
  assert.equal(passed, 11);
  console.log(JSON.stringify({ suite: 'workspace-local-link-parser-v4', passed, frontierLinks: frontierResult.links.length, syntaxFactsOnly: true }));
}
