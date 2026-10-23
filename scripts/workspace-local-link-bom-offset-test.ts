import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWorkspaceLocalLinks, parseWorkspaceLocalLinksV3, type ParsedWorkspaceLocalLink } from '../app/lib/markdown/workspace-local-link-parser';
import { inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3 } from '../app/lib/markdown/workspace-physical-link-inventory';

type ExpectedLink = Pick<ParsedWorkspaceLocalLink, 'raw' | 'syntax' | 'targetLiteral' | 'targetPathText' | 'fragment' | 'alias' | 'embed' | 'kind'>;
type BomOffsetFixture = Readonly<{ source: string; prefix: string; bom: boolean; newline: '\n' | '\r\n';
  expected: ExpectedLink[]; html: string | null }>;
const sourcePath = 'notes/bom-offset.md';

function bomOffsetFixture(bom: boolean, frontmatter: boolean, newline: '\n' | '\r\n'): BomOffsetFixture {
  const prefix = (bom ? '\uFEFF' : '') + (frontmatter
    ? ['---', 'title: "Front 😀"', 'example: "[Hidden](frontmatter.md) [[Hidden]]"', '---', ''].join(newline) : '');
  const html = '<img src="html-target.png">';
  const body = [
    '[First](first.md)', '',
    '😀 before [Inline](links/😀.md#Heading)', '',
    '![Image](<images/😀 image.png> "Image title")', '',
    '[Reference][ref]', '![Reference image][ref-image]', '[Shared link][shared] and ![Shared image][shared]', '[Angle][angle]', '',
    '[ref]: links/reference.md "Reference title"',
    '[ref-image]: images/reference.png',
    '[shared]: links/shared.md',
    '[angle]: <links/angle note.md> "Angle title"', '',
    '[[Wiki/😀#Section|Wiki label]] and ![[images/embed.png|Embed label]]', '',
    `Before ${html} after`, '',
    '`[Inline hidden](inline-code.md) [[Inline hidden]]`', '',
    '   ```md', '[Fence hidden](fenced-code.md) [[Fence hidden]]', '   ```', '',
    '    [Indent hidden](indented-code.md)', '    [[Indent hidden]]', '',
    '[After code](after-code.md)', '',
  ].join(newline);
  const markdown = (raw: string, syntax: ExpectedLink['syntax'], targetLiteral: string, targetPathText = targetLiteral,
    fragment: string | null = null, embed = false): ExpectedLink => ({ raw, syntax, targetLiteral, targetPathText, fragment,
    alias: null, embed, kind: 'markdown' });
  return { source: prefix + body, prefix: frontmatter ? prefix : '', bom, newline, html, expected: [
    markdown('[First](first.md)', 'inline-link', 'first.md'),
    markdown('[Inline](links/😀.md#Heading)', 'inline-link', 'links/😀.md#Heading', 'links/😀.md', 'Heading'),
    markdown('![Image](<images/😀 image.png> "Image title")', 'inline-image', 'images/😀 image.png', 'images/😀 image.png', null, true),
    markdown('[ref]: links/reference.md "Reference title"', 'reference-link', 'links/reference.md'),
    markdown('[ref-image]: images/reference.png', 'reference-image', 'images/reference.png', 'images/reference.png', null, true),
    markdown('[shared]: links/shared.md', 'reference-definition', 'links/shared.md'),
    markdown('[angle]: <links/angle note.md> "Angle title"', 'reference-definition', 'links/angle note.md'),
    { raw: '[[Wiki/😀#Section|Wiki label]]', syntax: 'wiki-link', targetLiteral: 'Wiki/😀#Section', targetPathText: 'Wiki/😀',
      fragment: 'Section', alias: 'Wiki label', embed: false, kind: 'wiki' },
    { raw: '![[images/embed.png|Embed label]]', syntax: 'wiki-embed', targetLiteral: 'images/embed.png', targetPathText: 'images/embed.png',
      fragment: null, alias: 'Embed label', embed: true, kind: 'wiki' },
    markdown('[After code](after-code.md)', 'inline-link', 'after-code.md'),
  ] };
}

/** Expected offsets come from unique explicit original snippets, independently
 * of mdast/parser offsets. UTF-8 ranges are checked against actual source bytes. */
function assertBomOffsetFixture(fixture: BomOffsetFixture): void {
  const originalBytes = Buffer.from(fixture.source, 'utf8'), beforeBytes = Buffer.from(originalBytes), before = structuredClone(fixture);
  const expected = fixture.expected.map(link => {
    const start = fixture.source.indexOf(link.raw);
    assert(start >= 0, link.raw); assert.equal(fixture.source.indexOf(link.raw, start + 1), -1, 'unique source snippet');
    const within = link.raw.indexOf(link.targetLiteral); assert(within >= 0, link.targetLiteral);
    assert.equal(link.raw.indexOf(link.targetLiteral, within + 1), -1, 'unique target within source snippet');
    return { ...link, start, end: start + link.raw.length, targetStart: start + within, targetEnd: start + within + link.targetLiteral.length,
      sourcePath, workspaceRootRelative: false };
  }).sort((a, b) => a.start - b.start);
  const unevaluated = fixture.html === null ? [] : [{ sourcePath, raw: fixture.html, reason: 'html' as const,
    start: fixture.source.indexOf(fixture.html), htmlTargets: ['html-target.png'] }];
  try {
    const parsed = parseWorkspaceLocalLinksV3(fixture.source, sourcePath, { notebookPaths: 'exact' });
    assert.deepEqual(parsed, { links: expected, unevaluated });
    const inventory = inspectOriginalPhysicalLinksV3({ workspaceId: 'bom-offset-workspace', organizationId: null, path: sourcePath,
      bytes: originalBytes, authority: { kind: 'unregistered', catalogueProof: 'a'.repeat(64) },
      filesystemIdentity: `1:102:${originalBytes.length}:100:100` });
    assert.equal(inventory.parserVersion, 3); assert.equal(inventory.hasBom, fixture.bom); assert.equal(inventory.frontmatterPrefix, fixture.prefix);
    assert.equal(inventory.physical.byteHash, createHash('sha256').update(originalBytes).digest('hex'));
    assert.equal(inventory.physical.byteLength, originalBytes.length); assert.equal(inventory.executionReady, false);
    assert.deepEqual(inventory.lineEndings, { style: fixture.newline === '\r\n' ? 'crlf' : 'lf',
      crlf: fixture.newline === '\r\n' ? fixture.source.split('\r\n').length - 1 : 0,
      lf: fixture.newline === '\n' ? fixture.source.split('\n').length - 1 : 0, bareCr: 0 });
    assert.deepEqual(inventory.coverage, fixture.html === null ? { complete: true, gaps: [] }
      : { complete: false, gaps: [{ code: 'uninspected-html', path: sourcePath, startUtf16: fixture.source.indexOf(fixture.html),
        htmlTargets: ['html-target.png'] }] });
    assert.equal(inventory.links.length, expected.length);
    for (const [index, link] of inventory.links.entries()) {
      const wanted = expected[index], { physicalLinkId, syntaxRange, targetRange, ...parsedLink } = link;
      assert.deepEqual(parsedLink, wanted); assert.match(physicalLinkId, /^physical:[a-f0-9]{64}$/u);
      assert.deepEqual(syntaxRange, { startUtf16: wanted.start, endUtf16: wanted.end,
        startUtf8Byte: Buffer.byteLength(fixture.source.slice(0, wanted.start)), endUtf8Byte: Buffer.byteLength(fixture.source.slice(0, wanted.end)) });
      assert.deepEqual(targetRange, { startUtf16: wanted.targetStart, endUtf16: wanted.targetEnd,
        startUtf8Byte: Buffer.byteLength(fixture.source.slice(0, wanted.targetStart)), endUtf8Byte: Buffer.byteLength(fixture.source.slice(0, wanted.targetEnd)) });
      assert.equal(originalBytes.subarray(syntaxRange.startUtf8Byte, syntaxRange.endUtf8Byte).toString('utf8'), wanted.raw);
      assert.equal(originalBytes.subarray(targetRange.startUtf8Byte, targetRange.endUtf8Byte).toString('utf8'), wanted.targetLiteral);
    }
    assert.deepEqual(inventory.originalBytes, Uint8Array.from(originalBytes));
  } finally {
    assert.deepEqual(fixture, before, 'source, CRLF, BOM, expected semantics and all snippets stay unchanged');
    assert.deepEqual(originalBytes, beforeBytes, 'physical parser must preserve the actual original bytes');
  }
}

export function testWorkspaceLocalLinkBomOffsets(): void {
  let matrix = 0, firstLine = 0;
  for (const bom of [false, true]) for (const frontmatter of [false, true]) for (const newline of ['\n', '\r\n'] as const) {
    assertBomOffsetFixture(bomOffsetFixture(bom, frontmatter, newline)); matrix++;
  }
  const outside: ExpectedLink = { raw: '[Outside](outside.md)', syntax: 'inline-link', targetLiteral: 'outside.md',
    targetPathText: 'outside.md', fragment: null, alias: null, embed: false, kind: 'markdown' };
  for (const bom of [false, true]) for (const kind of ['first-link', 'first-wiki', 'three-space-fence', 'four-space-code'] as const) {
    const prefix = bom ? '\uFEFF' : '', newline = '\r\n' as const;
    const body = kind === 'first-link' ? '[Outside](outside.md)\r\n'
      : kind === 'first-wiki' ? '[[outside]]\r\n'
        : kind === 'three-space-fence' ? '   ```md\r\n[Hidden](fence-hidden.md) [[Fence hidden]]\r\n   ```\r\n\r\n[Outside](outside.md)\r\n'
          : '    [Hidden](indent-hidden.md)\r\n    [[Indent hidden]]\r\n\r\n[Outside](outside.md)\r\n';
    const expected: ExpectedLink[] = kind === 'first-wiki' ? [{ raw: '[[outside]]', syntax: 'wiki-link', targetLiteral: 'outside',
      targetPathText: 'outside', fragment: null, alias: null, embed: false, kind: 'wiki' }] : [outside];
    assertBomOffsetFixture({ source: prefix + body, prefix: '', bom, newline, expected, html: null }); firstLine++;
  }
  // Only the first BOM is preprocessing metadata. A second U+FEFF stays real
  // source content; stripping twice would corrupt the original span mapping.
  assertBomOffsetFixture({ source: '\uFEFF\uFEFF[Outside](outside.md)\r\n', prefix: '', bom: true, newline: '\r\n',
    expected: [outside], html: null });
  assertBomOffsetFixture({ source: '\uFEFF\uFEFF[[outside]]\r\n', prefix: '', bom: true, newline: '\r\n', html: null,
    expected: [{ raw: '[[outside]]', syntax: 'wiki-link', kind: 'wiki', targetLiteral: 'outside', targetPathText: 'outside',
      fragment: null, alias: null, embed: false }] });

  // Retain this concrete historical parser distinction without claiming that
  // arbitrary parser-2 output is byte-equivalent to the new parser contract.
  const legacySource = '\uFEFF[[Only]]', bytes = Buffer.from(legacySource), beforeBytes = Buffer.from(bytes);
  try {
    assert.deepEqual(parseWorkspaceLocalLinks(legacySource, sourcePath, { notebookPaths: 'exact' }), { links: [], unevaluated: [] });
    const expected = { sourcePath, raw: '[[Only]]', syntax: 'wiki-link' as const, kind: 'wiki' as const, targetLiteral: 'Only',
      targetPathText: 'Only', fragment: null, alias: null, embed: false, workspaceRootRelative: false,
      start: 1, end: 9, targetStart: 3, targetEnd: 7 };
    assert.deepEqual(parseWorkspaceLocalLinksV3(legacySource, sourcePath, { notebookPaths: 'exact' }), { links: [expected], unevaluated: [] });
    const physicalInput = { workspaceId: 'bom-offset-workspace', organizationId: null, path: sourcePath,
      bytes, authority: { kind: 'unregistered' as const, catalogueProof: 'a'.repeat(64) }, filesystemIdentity: `1:103:${bytes.length}:100:100` };
    const legacyPhysical = inspectOriginalPhysicalLinks(physicalInput);
    assert.equal(legacyPhysical.parserVersion, 2); assert.deepEqual(legacyPhysical.links, []);
    assert.deepEqual(legacyPhysical.coverage, { complete: true, gaps: [] });
    const physical = inspectOriginalPhysicalLinksV3(physicalInput);
    assert.equal(physical.parserVersion, 3); assert.deepEqual(physical.coverage, { complete: true, gaps: [] });
    assert.equal(physical.links.length, 1);
    const { physicalLinkId: _id, syntaxRange, targetRange, ...link } = physical.links[0];
    assert.deepEqual(link, expected);
    assert.deepEqual(syntaxRange, { startUtf16: 1, endUtf16: 9, startUtf8Byte: 3, endUtf8Byte: 11 });
    assert.deepEqual(targetRange, { startUtf16: 3, endUtf16: 7, startUtf8Byte: 5, endUtf8Byte: 9 });
    assert.equal(bytes.subarray(3, 11).toString('utf8'), '[[Only]]'); assert.equal(bytes.subarray(5, 9).toString('utf8'), 'Only');
    assert.deepEqual(physical.originalBytes, Uint8Array.from(bytes));
  } finally { assert.deepEqual(bytes, beforeBytes); }
  // Metadata uses the single-BOM-less visible body, while immutable physical
  // facts remain the actual original bytes. A3-space opening fence must not
  // expose its hidden heading or hide the later genuine heading.
  for (const fixture of [
    { path: 'metadata/stable.md', body: '# Stable Ω\r\n\r\n## Nested Ω\r\n', title: 'Stable Ω',
      headings: [{ depth: 1, text: 'Stable Ω' }, { depth: 2, text: 'Nested Ω' }] },
    { path: 'metadata/fence.md', body: '   ```md\r\n# Hidden Ω\r\n   ```\r\n\r\n# Visible Ω\r\n', title: 'Visible Ω',
      headings: [{ depth: 1, text: 'Visible Ω' }] },
  ]) {
    const plain = Buffer.from(fixture.body), withBom = Buffer.from(`\uFEFF${fixture.body}`);
    const before = [Buffer.from(plain), Buffer.from(withBom)];
    try {
      const inventories = [plain, withBom].map((source, index) => inspectOriginalPhysicalLinksV3({ workspaceId: 'bom-offset-workspace',
        organizationId: null, path: fixture.path, bytes: source, authority: { kind: 'unregistered', catalogueProof: 'a'.repeat(64) },
        filesystemIdentity: `1:${104 + index}:${source.length}:100:100` }));
      assert.deepEqual(inventories[1].metadata, inventories[0].metadata, 'BOM is not a title or heading character');
      for (const [index, inventory] of inventories.entries()) {
        const source = index === 0 ? plain : withBom;
        assert.equal(inventory.parserVersion, 3); assert.equal(inventory.metadata.title, fixture.title);
        assert.deepEqual(inventory.metadata.headings, fixture.headings); assert.equal(inventory.frontmatterPrefix, '');
        assert.equal(inventory.hasBom, index === 1); assert.deepEqual(inventory.originalBytes, Uint8Array.from(source));
        assert.equal(inventory.physical.byteLength, source.length);
        assert.equal(inventory.physical.byteHash, createHash('sha256').update(source).digest('hex'));
        assert.deepEqual(inventory.links, []); assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
      }
      assert.notEqual(inventories[0].physical.byteHash, inventories[1].physical.byteHash, 'BOM stays in original-byte identity');
    } finally { assert.deepEqual([plain, withBom], before); }
  }
  assert.equal(matrix, 8); assert.equal(firstLine, 8);
  console.log(JSON.stringify({ suite: 'workspace-local-link-bom-offset-v3', matrix, firstLine, doubleBom: 2, legacyEofCounterexample: 1,
    metadataGroup: 1, metadataSources: 4, pureOnly: true, originalUtf8SpanChecks: true, databaseOrFilesystemAcceptance: false }));
}
