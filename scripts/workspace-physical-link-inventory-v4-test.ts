import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import { inspectOriginalPhysicalHtmlV4, inspectOriginalPhysicalLinks, inspectOriginalPhysicalLinksV3,
  inspectOriginalPhysicalLinksV4, originalPhysicalHtmlSourceProofV4, originalPhysicalSourceProofV4,
  type OriginalPhysicalLinkInventoryV4, type PhysicalLinkSourceAuthority }
  from '../app/lib/markdown/workspace-physical-link-inventory';

type Input = Parameters<typeof inspectOriginalPhysicalLinksV4>[0];
const unregistered: PhysicalLinkSourceAuthority = { kind: 'unregistered', catalogueProof: 'a'.repeat(64) };
const pristine: PhysicalLinkSourceAuthority = { kind: 'registered-never-initialized', catalogueProof: 'b'.repeat(64),
  registeredDocumentId: 'pristine-document', lineageId: 'pristine-lineage' };
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Declared catalogue/FS facts, actual original bytes. No SQL/FS ownership,
 * current permission, import, operation assessment or execution is demonstrated. */
function sourceInput(source: string | Uint8Array, filePath = 'Notes/Source.md',
  authority: PhysicalLinkSourceAuthority = unregistered): Input {
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
  return { workspaceId: 'physical-v4-workspace', organizationId: null, path: filePath,
    authority: structuredClone(authority), bytes, filesystemIdentity: `1:41:${bytes.byteLength}:100.5:101.5` };
}

type ExpectedLink = { raw: string; literal: string; path: string; kind: 'markdown' | 'wiki';
  syntax: OriginalPhysicalLinkInventoryV4['links'][number]['syntax']; alias?: string; fragment?: string };

/** Independent original snippets and byte prefixes locate both editable target
 * and full syntax; no expected offset comes from another parser or inventory. */
function originalRanges(source: string, input: Input, inventory: OriginalPhysicalLinkInventoryV4,
  expected: ExpectedLink[]): void {
  assert.equal(inventory.links.length, expected.length);
  let cursor = 0;
  for (const [index, wanted] of expected.entries()) {
    const link = inventory.links[index], start = source.indexOf(wanted.raw, cursor);
    assert(start >= cursor); cursor = start + wanted.raw.length;
    const targetOffset = wanted.kind === 'wiki' ? wanted.raw.indexOf(wanted.literal, wanted.raw.startsWith('!') ? 3 : 2)
      : wanted.raw.lastIndexOf(wanted.literal);
    assert(targetOffset >= 0);
    const targetStart = start + targetOffset, end = start + wanted.raw.length, targetEnd = targetStart + wanted.literal.length;
    assert.equal(link.sourcePath, input.path); assert.equal(link.kind, wanted.kind); assert.equal(link.syntax, wanted.syntax);
    assert.equal(link.raw, wanted.raw); assert.equal(link.targetLiteral, wanted.literal); assert.equal(link.targetPathText, wanted.path);
    assert.equal(link.alias, wanted.alias ?? null); assert.equal(link.fragment, wanted.fragment ?? null);
    assert.equal(link.start, start); assert.equal(link.end, end);
    assert.equal(link.targetStart, targetStart); assert.equal(link.targetEnd, targetEnd);
    assert.deepEqual(link.syntaxRange, { startUtf16: start, endUtf16: end,
      startUtf8Byte: Buffer.byteLength(source.slice(0, start)), endUtf8Byte: Buffer.byteLength(source.slice(0, end)) });
    assert.deepEqual(link.targetRange, { startUtf16: targetStart, endUtf16: targetEnd,
      startUtf8Byte: Buffer.byteLength(source.slice(0, targetStart)), endUtf8Byte: Buffer.byteLength(source.slice(0, targetEnd)) });
    assert.equal(source.slice(start, end), wanted.raw); assert.equal(source.slice(targetStart, targetEnd), wanted.literal);
    assert.equal(Buffer.from(input.bytes).subarray(link.syntaxRange.startUtf8Byte, link.syntaxRange.endUtf8Byte).toString('utf8'), wanted.raw);
    assert.equal(Buffer.from(input.bytes).subarray(link.targetRange.startUtf8Byte, link.targetRange.endUtf8Byte).toString('utf8'), wanted.literal);
    assert.match(link.physicalLinkId, /^physical:[a-f0-9]{64}$/u);
  }
}

export function workspacePhysicalLinkInventoryV4Test(): void {
  let groups = 0;

  // 1. Ordinary Markdown preserves actual bytes, authority, metadata and ranges;
  // only the explicit parser/HTML facts and their source proof are new.
  const normal = '# Original\n\n[Plan](plan.md#Part) [[Note|Alias]]\n';
  for (const authority of [unregistered, pristine]) {
    const input = sourceInput(normal, 'Notes/Source.md', authority);
    const before = { ...input, authority: structuredClone(input.authority), bytes: Buffer.from(input.bytes) };
    const old = inspectOriginalPhysicalLinksV3(input), oldBefore = JSON.stringify(old), actual = inspectOriginalPhysicalLinksV4(input);
    const { parserVersion: _oldParser, physicalSourceProof: _oldProof, ...oldFacts } = old;
    const { parserVersion: _newParser, physicalSourceProof: _newProof, htmlInspection, ...newFacts } = actual;
    assert.deepEqual(newFacts, oldFacts); assert.equal(actual.parserVersion, 4);
    assert.deepEqual(htmlInspection, { parserVersion: 4, occurrences: [] });
    assert.notEqual(actual.physicalSourceProof, old.physicalSourceProof);
    assert.equal(actual.physicalSourceProof, originalPhysicalSourceProofV4(actual));
    assert.equal(actual.physical.byteHash, sha(input.bytes)); assert.equal(actual.physical.byteLength, input.bytes.byteLength);
    assert.deepEqual(input, before); assert.equal(JSON.stringify(inspectOriginalPhysicalLinksV3(input)), oldBefore);
    assert.equal(actual.executionReady, false); assert.equal(actual.applicability, 'requires-import-and-rebinding');
    assert.deepEqual(actual.coverage, { complete: true, gaps: [] });
    originalRanges(normal, input, actual, [
      { raw: '[Plan](plan.md#Part)', literal: 'plan.md#Part', path: 'plan.md', kind: 'markdown', syntax: 'inline-link', fragment: 'Part' },
      { raw: '[[Note|Alias]]', literal: 'Note', path: 'Note', kind: 'wiki', syntax: 'wiki-link', alias: 'Alias' },
    ]);
  }
  groups++;

  // 2. UTF-16 and UTF-8 coordinates independently include BOM, CRLF and Unicode.
  for (const bom of ['', '\uFEFF']) for (const newline of ['\n', '\r\n']) {
    const source = `${bom}# 😀 Heading${newline}${newline}😀 [Résumé](dir/😀.md#Part)${newline}`
      + `[[Note#^block|<img src="literal.png">]]${newline}`;
    const input = sourceInput(source), actual = inspectOriginalPhysicalLinksV4(input);
    originalRanges(source, input, actual, [
      { raw: '[Résumé](dir/😀.md#Part)', literal: 'dir/😀.md#Part', path: 'dir/😀.md', kind: 'markdown', syntax: 'inline-link', fragment: 'Part' },
      { raw: '[[Note#^block|<img src="literal.png">]]', literal: 'Note#^block', path: 'Note', kind: 'wiki', syntax: 'wiki-link',
        alias: '<img src="literal.png">', fragment: '^block' },
    ]);
    assert.equal(actual.hasBom, Boolean(bom)); assert.equal(actual.lineEndings.style, newline === '\r\n' ? 'crlf' : 'lf');
    assert.deepEqual(actual.htmlInspection, { parserVersion: 4, occurrences: [] });
    assert.deepEqual(actual.coverage, { complete: true, gaps: [] });
    assert.deepEqual(Buffer.from(actual.originalBytes), Buffer.from(source));
  }
  groups++;

  // 3. Retained originals and authority are detached from the supplied buffers.
  const mutable = sourceInput('[Original](original.md)', 'Original.md', pristine);
  const detached = inspectOriginalPhysicalLinksV4(mutable), detachedBefore = structuredClone(detached);
  assert.notEqual(detached.originalBytes, mutable.bytes); assert.notEqual(detached.authority, mutable.authority);
  mutable.bytes[0] ^= 1; mutable.authority.catalogueProof = 'c'.repeat(64);
  assert.deepEqual(detached, detachedBefore);
  assert.equal(detached.physicalSourceProof, originalPhysicalSourceProofV4(detached));
  groups++;

  // 4. Metadata views strip an initial BOM and exclude literal YAML headings/IDs.
  const bomHeading = inspectOriginalPhysicalLinksV4(sourceInput('\uFEFF# Heading\nText'));
  assert.deepEqual(bomHeading.metadata.headings, [{ depth: 1, text: 'Heading' }]);
  assert.equal(bomHeading.metadata.title, 'Heading'); assert.equal(bomHeading.metadata.hasExplicitTitle, false);
  const fmPrefix = '\uFEFF---\ntitle: Explicit 😀\naliases: [Shared]\ntags: [native]\nexample: |\n'
    + '  # Hidden heading\n  Hidden ^yaml-block\n  [[Hidden]] <img src="hidden.png">\n---\n';
  const fm = fmPrefix + '\n# Body Heading\nBody ^body-block\n\n[Visible](visible.md)\n';
  const fmInput = sourceInput(fm), fmInventory = inspectOriginalPhysicalLinksV4(fmInput);
  assert.deepEqual(fmInventory.metadata, { path: fmInput.path, aliases: ['Shared'], tags: ['native'], title: 'Explicit 😀',
    hasExplicitTitle: true, headings: [{ depth: 1, text: 'Body Heading' }], blockIds: ['body-block'] });
  assert.equal(fmInventory.frontmatterPrefix, fmPrefix);
  originalRanges(fm, fmInput, fmInventory, [
    { raw: '[Visible](visible.md)', literal: 'visible.md', path: 'visible.md', kind: 'markdown', syntax: 'inline-link' },
  ]);
  assert.deepEqual(fmInventory.htmlInspection, { parserVersion: 4, occurrences: [] });
  groups++;

  // 5. The full HTML occurrence list includes nested, opaque and external nodes;
  // ordinary gaps remain incomplete and never become execution permission.
  const htmlMarkdown = '😀 Before <img src="asset.png"> '
    + '[<custom-element resource="hidden.png">Label</custom-element>](keep.md) '
    + '<img src="https://example.test/external.png">';
  const htmlMarkdownInput = sourceInput(htmlMarkdown), inspected = inspectOriginalPhysicalLinksV4(htmlMarkdownInput);
  const htmlRaws = ['<img src="asset.png">', '<custom-element resource="hidden.png">', '</custom-element>',
    '<img src="https://example.test/external.png">'];
  assert.deepEqual(inspected.htmlInspection.occurrences.map(value => value.raw), htmlRaws);
  assert.deepEqual(inspected.htmlInspection.occurrences.map(value => value.fullyInspected), [true, false, false, true]);
  assert.deepEqual(inspected.htmlInspection.occurrences.map(value => value.explicitLocalTargets), [['asset.png'], [], [], []]);
  for (const occurrence of inspected.htmlInspection.occurrences) {
    assert.equal(occurrence.sourcePath, htmlMarkdownInput.path); assert.equal(occurrence.start, htmlMarkdown.indexOf(occurrence.raw));
    assert.equal(occurrence.end, occurrence.start + occurrence.raw.length);
    assert.equal(htmlMarkdown.slice(occurrence.start, occurrence.end), occurrence.raw);
  }
  assert.equal(inspected.coverage.complete, false);
  assert.deepEqual(inspected.coverage.gaps.map(gap => gap.code), ['uninspected-html', 'uninspected-html', 'uninspected-html']);
  assert.equal(inspected.executionReady, false); assert.equal(inspected.applicability, 'requires-import-and-rebinding');
  originalRanges(htmlMarkdown, htmlMarkdownInput, inspected, [
    { raw: '[<custom-element resource="hidden.png">Label</custom-element>](keep.md)', literal: 'keep.md', path: 'keep.md', kind: 'markdown', syntax: 'inline-link' },
  ]);
  groups++;

  // 6. Complete zero-target HTML and no-HTML text are explicit distinct facts.
  for (const source of ['', '# Text\n😀', '<div class="note">Static</div>', '<img src="https://example.test/image.png">']) {
    const actual = inspectOriginalPhysicalLinksV4(sourceInput(source));
    assert.deepEqual(actual.links, []); assert.deepEqual(actual.coverage, { complete: true, gaps: [] });
    assert(actual.htmlInspection.occurrences.every(value => value.fullyInspected && value.explicitLocalTargets.length === 0));
    assert.equal(actual.htmlInspection.occurrences.length, source.startsWith('<') ? 1 : 0);
    assert.equal(actual.executionReady, false);
  }
  groups++;

  // 7. The Markdown source proof covers full inspection facts and actual bytes,
  // even if a caller leaves the claimed byteHash unchanged while tampering.
  for (const change of [
    (value: OriginalPhysicalLinkInventoryV4) => { value.htmlInspection.occurrences[0].fullyInspected = false; },
    (value: OriginalPhysicalLinkInventoryV4) => { value.htmlInspection.occurrences[0].explicitLocalTargets = []; },
    (value: OriginalPhysicalLinkInventoryV4) => { value.htmlInspection.occurrences = []; },
    (value: OriginalPhysicalLinkInventoryV4) => { value.originalBytes[0] ^= 1; },
    (value: OriginalPhysicalLinkInventoryV4) => { value.physical.filesystemIdentity = `1:42:${value.originalBytes.length}:100.5:101.5`; },
  ]) {
    const altered = structuredClone(inspected); change(altered);
    assert.notEqual(originalPhysicalSourceProofV4(altered), inspected.physicalSourceProof);
  }
  assert.equal(originalPhysicalSourceProofV4(inspected), inspected.physicalSourceProof);
  groups++;

  // 8. New source kinds cannot be relabelled across Markdown/HTML/other formats.
  for (const filePath of ['Source.html', 'Source.htm', 'Source.mdx', 'Source.bin']) {
    assert.throws(() => inspectOriginalPhysicalLinksV4(sourceInput('Text', filePath)), /requires a Markdown source/u);
  }
  for (const filePath of ['Source.md', 'Source.markdown', 'Source.mdx', 'Source.bin']) {
    assert.throws(() => inspectOriginalPhysicalHtmlV4(sourceInput('<div>Text</div>', filePath)), /requires an HTML source/u);
  }
  assert.equal(inspectOriginalPhysicalLinksV4(sourceInput('Text', 'Source.MARKDOWN')).parserVersion, 4);
  assert.equal(inspectOriginalPhysicalHtmlV4(sourceInput('Text', 'Source.HTM')).htmlSourceVersion, 4);
  groups++;

  // 9. Malformed/overlong/surrogate UTF-8 and NUL never yield source facts.
  for (const bytes of [Uint8Array.of(0xc3, 0x28), Uint8Array.of(0xc0, 0xaf), Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0xe2, 0x82), Buffer.from('Text\0Tail')]) {
    const before = Buffer.from(bytes);
    assert.throws(() => inspectOriginalPhysicalLinksV4(sourceInput(bytes)), Error);
    assert.throws(() => inspectOriginalPhysicalHtmlV4(sourceInput(bytes, 'Source.html')), Error);
    assert.deepEqual(Buffer.from(bytes), before);
  }
  groups++;

  // 10. Standalone HTML never manufactures Markdown metadata, links or imports.
  const htmlOriginal = '\uFEFF---\r\ntitle: NotMetadata\r\n---\r\n# Not Markdown\r\n'
    + '[[NotWiki]] [NoLink](no.md)\r\n<div class="note">😀 Static</div>\r\n';
  const htmlInput = sourceInput(htmlOriginal, 'Pages/Original.html', pristine);
  const html = inspectOriginalPhysicalHtmlV4(htmlInput);
  assert.equal(html.htmlSourceVersion, 4); assert.equal(html.source, 'original-physical-html-bytes');
  assert.equal(html.workspaceId, htmlInput.workspaceId); assert.equal(html.organizationId, null); assert.equal(html.path, htmlInput.path);
  assert.deepEqual(html.authority, pristine); assert.notEqual(html.authority, htmlInput.authority);
  assert.deepEqual(html.physical, { filesystemIdentity: htmlInput.filesystemIdentity, byteHash: sha(htmlInput.bytes), byteLength: htmlInput.bytes.length });
  assert.deepEqual(Buffer.from(html.originalBytes), Buffer.from(htmlOriginal)); assert.notEqual(html.originalBytes, htmlInput.bytes);
  assert.equal(html.encoding, 'utf8'); assert.equal(html.hasBom, true);
  assert.deepEqual(html.lineEndings, { style: 'crlf', lf: 0, crlf: 6, bareCr: 0 });
  assert.deepEqual(html.htmlInspection, { inspectionVersion: 1, fullyInspected: true, explicitLocalTargets: [] });
  for (const forbidden of ['metadata', 'links', 'frontmatterPrefix', 'parserVersion', 'physicalSourceProof', 'coverage']) {
    assert.equal(Object.hasOwn(html, forbidden), false, forbidden);
  }
  assert.equal(html.executionReady, false); assert.equal(html.applicability, 'requires-operation-assessment');
  assert.equal(html.htmlSourceProof, originalPhysicalHtmlSourceProofV4(html));
  groups++;

  // 11. Whole static inspection retains duplicate once-decoded local targets;
  // external/zero-target and unknown/dynamic sources remain distinguishable.
  for (const [source, fullyInspected, targets] of [
    ['<div class="note">Static</div>', true, []],
    ['<img src="https://example.test/image.png"><a href="#section">Local anchor</a>', true, []],
    ['<div><img src="assets/a&amp;b.png"><a href="../Note%23Final.md#Part">Note</a><img src="assets/a&amp;b.png"></div>',
      true, ['assets/a&b.png', '../Note#Final.md', 'assets/a&b.png']],
    ['<custom-element resource="hidden.png">Body</custom-element>', false, []],
    ['<img src="javascript:run()">', false, []],
    ['<style>body { background: url(hidden.png) }</style>', false, []],
    ['<div style="background:url(hidden.png)">Body</div>', false, []],
    ['<img src="known.png" onerror="run()">', false, ['known.png']],
  ] as const) {
    const actual = inspectOriginalPhysicalHtmlV4(sourceInput(source, 'Pages/Source.html'));
    assert.deepEqual(actual.htmlInspection, { inspectionVersion: 1, fullyInspected, explicitLocalTargets: [...targets] });
    assert.equal(actual.executionReady, false); assert.equal(actual.applicability, 'requires-operation-assessment');
  }
  groups++;

  // 12. Standalone HTML proofs cover inspection fields and actual original bytes.
  const linkedHtml = inspectOriginalPhysicalHtmlV4(sourceInput('<img src="asset.png">', 'Source.html'));
  for (const altered of [
    { ...structuredClone(linkedHtml), htmlInspection: { ...linkedHtml.htmlInspection, fullyInspected: false } },
    { ...structuredClone(linkedHtml), htmlInspection: { ...linkedHtml.htmlInspection, explicitLocalTargets: [] } },
    { ...structuredClone(linkedHtml), originalBytes: Buffer.from('<img src="other.png">') },
    { ...structuredClone(linkedHtml), authority: { ...linkedHtml.authority, catalogueProof: 'c'.repeat(64) } },
  ]) assert.notEqual(originalPhysicalHtmlSourceProofV4(altered), linkedHtml.htmlSourceProof);
  assert.equal(originalPhysicalHtmlSourceProofV4(linkedHtml), linkedHtml.htmlSourceProof);
  groups++;

  // 13. Both source kinds retain original line-ending counts, not normalized text.
  for (const [source, expected] of [
    ['Text', { style: 'none', lf: 0, crlf: 0, bareCr: 0 }],
    ['A\nB\n', { style: 'lf', lf: 2, crlf: 0, bareCr: 0 }],
    ['A\r\nB\r\n', { style: 'crlf', lf: 0, crlf: 2, bareCr: 0 }],
    ['A\r\nB\n', { style: 'mixed', lf: 1, crlf: 1, bareCr: 0 }],
    ['A\rB\n', { style: 'bare-cr', lf: 1, crlf: 0, bareCr: 1 }],
  ] as const) {
    assert.deepEqual(inspectOriginalPhysicalLinksV4(sourceInput(source)).lineEndings, expected);
    assert.deepEqual(inspectOriginalPhysicalHtmlV4(sourceInput(source, 'Source.html')).lineEndings, expected);
  }
  groups++;

  // 14. Each 4MiB byte bound rejects before Uint8Array.from can read/copy input.
  const oversized = new Uint8Array(MAX_INDEXED_MARKDOWN_BYTES + 1);
  let copied = 0;
  Object.defineProperty(oversized, Symbol.iterator, { value: () => { copied++; throw new Error('Oversized source must not be copied'); } });
  assert.throws(() => inspectOriginalPhysicalLinksV4(sourceInput(oversized)), RangeError);
  assert.throws(() => inspectOriginalPhysicalHtmlV4(sourceInput(oversized, 'Source.html')), RangeError);
  assert.equal(copied, 0);

  // An apparent smaller size cannot hide the genuine oversized storage.
  Object.defineProperty(oversized, 'byteLength', { value: 0 });
  assert.throws(() => inspectOriginalPhysicalLinksV4(sourceInput(oversized)), TypeError);
  assert.throws(() => inspectOriginalPhysicalHtmlV4(sourceInput(oversized, 'Source.html')), TypeError);
  assert.equal(copied, 0);

  // Small real storage stays small even when its iterator would yield >4MiB.
  let iteratorCalls = 0;
  function* excessiveIterator() {
    iteratorCalls++;
    for (let index = 0; index <= MAX_INDEXED_MARKDOWN_BYTES; index++) yield 0x61;
  }
  const mdText = '[Real](real.md)', htmlText = '<img src="real.png">';
  const mdBytes = Uint8Array.from(Buffer.from(mdText)), htmlBytes = Buffer.from(htmlText);
  Object.defineProperty(mdBytes, Symbol.iterator, { value: excessiveIterator });
  Object.defineProperty(htmlBytes, Symbol.iterator, { value: excessiveIterator });
  const actualMd = inspectOriginalPhysicalLinksV4(sourceInput(mdBytes));
  const actualHtml = inspectOriginalPhysicalHtmlV4(sourceInput(htmlBytes, 'Source.html'));
  assert.equal(iteratorCalls, 0);
  assert.deepEqual(Buffer.from(actualMd.originalBytes), Buffer.from(mdText));
  assert.deepEqual(Buffer.from(actualHtml.originalBytes), Buffer.from(htmlText));
  assert.equal(actualMd.physical.byteLength, Buffer.byteLength(mdText));
  assert.equal(actualHtml.physical.byteLength, Buffer.byteLength(htmlText));
  assert.deepEqual(actualMd.links.map(link => [link.kind, link.targetLiteral]), [['markdown', 'real.md']]);
  assert.deepEqual(actualHtml.htmlInspection, { inspectionVersion: 1, fullyInspected: true, explicitLocalTargets: ['real.png'] });

  // Only actual private byte storage is eligible; proxy traps remain unexecuted.
  let proxyTraps = 0;
  const proxiedBytes = new Proxy(Uint8Array.of(0x61), {
    getPrototypeOf() { proxyTraps++; return Uint8Array.prototype; },
    get() { proxyTraps++; throw new Error('A byte proxy must be rejected before property reads'); },
  });
  class ByteSubclass extends Uint8Array {}
  const shared = new SharedArrayBuffer(1), disguisedShared = new SharedArrayBuffer(1);
  const sharedBytes = new Uint8Array(shared), disguisedSharedBytes = new Uint8Array(disguisedShared);
  sharedBytes[0] = 0x61; disguisedSharedBytes[0] = 0x61;
  Object.setPrototypeOf(disguisedShared, ArrayBuffer.prototype);
  for (const bytes of [proxiedBytes, new ByteSubclass([0x61]), sharedBytes, disguisedSharedBytes]) {
    // Do not inspect the hostile bytes in this fixture constructor.
    assert.throws(() => inspectOriginalPhysicalLinksV4({ ...sourceInput('a'), bytes }), TypeError);
    assert.throws(() => inspectOriginalPhysicalHtmlV4({ ...sourceInput('a', 'Source.html'), bytes }), TypeError);
  }
  assert.equal(proxyTraps, 0); assert.equal(iteratorCalls, 0);
  groups++;

  // 15. A caller's smaller legal Markdown link budget cannot emit partial links.
  const twoLinks = sourceInput('[One](one.md) [[Two]]');
  for (const maxLinks of [-1, 0.5, NaN, Infinity, 20_001]) {
    assert.throws(() => inspectOriginalPhysicalLinksV4({ ...twoLinks, maxLinks }), /Invalid physical source link bound/u);
  }
  for (const maxLinks of [0, 1]) {
    const limited = inspectOriginalPhysicalLinksV4({ ...twoLinks, maxLinks });
    assert.deepEqual(limited.links, []);
    assert.deepEqual(limited.coverage, { complete: false, gaps: [{ code: 'source-link-limit', path: twoLinks.path }] });
    assert.equal(limited.executionReady, false);
  }
  assert.equal(inspectOriginalPhysicalLinksV4({ ...twoLinks, maxLinks: 2 }).links.length, 2);
  assert.deepEqual(inspectOriginalPhysicalLinksV4({ ...sourceInput('No links'), maxLinks: 0 }).coverage, { complete: true, gaps: [] });
  groups++;

  // 16. Fixed parser/HTML output caps reject rather than truncate source facts.
  for (const source of ['[[Note]] '.repeat(20_001), '[Note](note.md) '.repeat(20_001)]) {
    assert(Buffer.byteLength(source) < MAX_INDEXED_MARKDOWN_BYTES);
    assert.throws(() => inspectOriginalPhysicalLinksV4(sourceInput(source)), RangeError);
  }
  const tooManyHtmlTargets = '<img src="asset.png">'.repeat(20_001);
  assert(Buffer.byteLength(tooManyHtmlTargets) < MAX_INDEXED_MARKDOWN_BYTES);
  assert.throws(() => inspectOriginalPhysicalHtmlV4(sourceInput(tooManyHtmlTargets, 'Source.html')), RangeError);
  groups++;

  // 17. Historical BOM parsing and unconditional .html gaps remain historical.
  const oldBomInput = sourceInput('\uFEFF[[Only]]'), old2 = inspectOriginalPhysicalLinks(oldBomInput), old3 = inspectOriginalPhysicalLinksV3(oldBomInput);
  assert.deepEqual(old2.links, []); assert.equal(old2.parserVersion, 2);
  assert.equal(old3.parserVersion, 3); assert.equal(old3.links.length, 1);
  assert.equal(old3.links[0].raw, '[[Only]]'); assert.equal(old3.links[0].targetLiteral, 'Only');
  assert.deepEqual(old3.links[0].syntaxRange, { startUtf16: 1, endUtf16: 9, startUtf8Byte: 3, endUtf8Byte: 11 });
  assert.deepEqual(old3.links[0].targetRange, { startUtf16: 3, endUtf16: 7, startUtf8Byte: 5, endUtf8Byte: 9 });
  const oldHtmlInput = sourceInput('<div class="note">Static</div>', 'Source.html');
  const oldHtml2 = inspectOriginalPhysicalLinks(oldHtmlInput), oldHtml3 = inspectOriginalPhysicalLinksV3(oldHtmlInput);
  for (const old of [old2, old3, oldHtml2, oldHtml3]) assert.equal(Object.hasOwn(old, 'htmlInspection'), false);
  for (const old of [oldHtml2, oldHtml3]) assert.deepEqual(old.coverage,
    { complete: false, gaps: [{ code: 'uninspected-html', path: 'Source.html' }] });
  const historyBefore = JSON.stringify([old2, old3, oldHtml2, oldHtml3]);
  inspectOriginalPhysicalLinksV4(oldBomInput); inspectOriginalPhysicalHtmlV4(oldHtmlInput);
  assert.equal(JSON.stringify([inspectOriginalPhysicalLinks(oldBomInput), inspectOriginalPhysicalLinksV3(oldBomInput),
    inspectOriginalPhysicalLinks(oldHtmlInput), inspectOriginalPhysicalLinksV3(oldHtmlInput)]), historyBefore);
  groups++;

  assert.equal(groups, 17);
  console.log(JSON.stringify({ suite: 'workspace-physical-link-inventory-v4', groups,
    actualOriginalBytes: true, declaredCatalogueAndFilesystem: true, factsOnly: true, executionAuthority: false }));
}
