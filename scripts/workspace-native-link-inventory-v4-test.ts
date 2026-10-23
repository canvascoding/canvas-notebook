import assert from 'node:assert/strict';
import type * as YTypes from 'yjs';

import { authoritativeNativeCollaborationSnapshot, inspectPersistedNativeCollaborationSnapshot }
  from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { Y } from '../app/lib/collaboration/server-runtime';
import type { NativeDocumentLink, NativeLinkTextReference } from '../app/lib/markdown/workspace-link-contract-v2';
import { MAX_INDEXED_MARKDOWN_BYTES } from '../app/lib/markdown/workspace-link-limits';
import { inspectNativeDocumentLinks, inspectNativeDocumentLinksV4, inspectPersistedDocumentLinksV4,
  type NativeDocumentLinkInventoryV4 } from '../app/lib/markdown/workspace-native-link-inventory';
import { nativeRichDocumentFixture, nativeTableWidthFixture } from './helpers/rich-markdown-projection-fixtures';

// Pure inventory facts from actual Yjs bytes and the real snapshot seam. Fixture
// identities/clocks supply no storage, principal, owner or execution authority.
function stateFor(doc: YTypes.Doc, representation: PersistedCollaborationState['representation'],
  path = 'Notes/Source.md'): PersistedCollaborationState {
  const text = representation === 'plain_text' ? doc.getText('content').toString() : '';
  return { documentId: 'inventory-v4-document', workspaceId: 'inventory-v4-workspace', organizationId: null,
    path, representation, lifecycleGeneration: 3, schemaVersion: 1,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 5, persistedAt: 1000, checkpointSequence: 2, checkpointedAt: 999,
    canonicalHash: null, serializedHash: null, newlineStyle: text.includes('\r\n') ? 'crlf' : 'lf',
    hasBom: text.charCodeAt(0) === 0xfeff, degraded: false, status: 'active' };
}

function readInventory(doc: YTypes.Doc, representation: PersistedCollaborationState['representation'] = 'plain_text') {
  const state = stateFor(doc, representation), bytesBefore = Buffer.from(state.yjsState);
  const snapshot = authoritativeNativeCollaborationSnapshot(state);
  const inventory = inspectNativeDocumentLinksV4(doc, snapshot);
  assert.deepEqual(Buffer.from(Y.encodeStateAsUpdate(doc)), bytesBefore, 'Inspection must not write the actual document');
  assert.deepEqual(Buffer.from(Y.encodeStateVector(doc)), Buffer.from(state.stateVector));
  assert.equal(inventory.parserVersion, 4);
  assert.deepEqual(inventory.version, snapshot.version);
  return { state, snapshot, inventory };
}

function absoluteRange(doc: YTypes.Doc, reference: NativeLinkTextReference): { start: number; end: number; value: string } {
  const position = (encoded: string): number => {
    const relative = Y.decodeRelativePosition(Buffer.from(encoded, 'base64'));
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    assert(absolute, 'The actual original document must resolve its relative position');
    assert.equal(absolute.type, doc.getText('content'));
    return absolute.index;
  };
  const start = position(reference.startAnchor), end = position(reference.endAnchor);
  assert(start <= end);
  return { start, end, value: doc.getText('content').toString().slice(start, end) };
}

type ExpectedPlainLink = Pick<NativeDocumentLink, 'kind' | 'syntax' | 'literal' | 'targetPathText'> & {
  raw: string; alias?: string; fragment?: string;
};

/** Expected locations come from explicit original snippets, never parser output. */
function assertPlainLinks(doc: YTypes.Doc, inventory: NativeDocumentLinkInventoryV4,
  source: string, expected: ExpectedPlainLink[]): void {
  assert.equal(inventory.links.length, expected.length);
  let cursor = 0;
  for (const [index, value] of expected.entries()) {
    const link = inventory.links[index], reference = link.ref;
    assert.equal(link.kind, value.kind); assert.equal(link.syntax, value.syntax);
    assert.equal(link.literal, value.literal); assert.equal(link.targetPathText, value.targetPathText);
    assert.equal(link.alias, value.alias ?? null); assert.equal(link.fragment, value.fragment ?? null);
    assert.equal(link.embed, value.syntax === 'inline-image' || value.syntax === 'wiki-embed');
    assert.equal(link.classification, 'local'); assert.equal(reference.kind, 'plain-target');
    if (reference.kind !== 'plain-target') throw new Error('Plain fixture produced a non-plain reference');
    const start = source.indexOf(value.raw, cursor);
    assert(start >= cursor); cursor = start + value.raw.length;
    const targetOffset = value.kind === 'wiki' ? value.raw.indexOf(value.literal, value.raw.startsWith('!') ? 3 : 2)
      : value.raw.lastIndexOf(value.literal);
    assert(targetOffset >= 0);
    assert.equal(reference.raw, value.raw); assert.equal(reference.expected, value.literal);
    assert.equal(reference.syntaxStart, start); assert.equal(reference.syntaxEnd, start + value.raw.length);
    assert.equal(reference.targetStart, start + targetOffset);
    assert.equal(reference.targetEnd, start + targetOffset + value.literal.length);
    assert.equal(reference.text.blockId, null); assert.equal(reference.syntaxText.blockId, null);
    assert.deepEqual(absoluteRange(doc, reference.text), {
      start: reference.targetStart, end: reference.targetEnd, value: value.literal,
    });
    assert.deepEqual(absoluteRange(doc, reference.syntaxText), {
      start: reference.syntaxStart, end: reference.syntaxEnd, value: value.raw,
    });
  }
}

export function workspaceNativeLinkInventoryV4Test(): void {
  let groups = 0;

  // Ordinary parser-2 cases retain every inventory field except the explicit version.
  const standard = '# Stable\n\n[Visible](target.md#Part) [[Wiki#Heading|Alias]] ![Image](image.png)\n';
  const standardDoc = createPlainTextYDoc(standard);
  try {
    const { inventory, snapshot, state } = readInventory(standardDoc);
    assert.deepEqual(inventory, { ...inspectNativeDocumentLinks(standardDoc, snapshot), parserVersion: 4 });
    assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
    assertPlainLinks(standardDoc, inventory, standard, [
      { kind: 'markdown', syntax: 'inline-link', literal: 'target.md#Part', targetPathText: 'target.md',
        fragment: 'Part', raw: '[Visible](target.md#Part)' },
      { kind: 'wiki', syntax: 'wiki-link', literal: 'Wiki#Heading', targetPathText: 'Wiki',
        fragment: 'Heading', alias: 'Alias', raw: '[[Wiki#Heading|Alias]]' },
      { kind: 'markdown', syntax: 'inline-image', literal: 'image.png', targetPathText: 'image.png', raw: '![Image](image.png)' },
    ]);
    assert.deepEqual(inspectPersistedDocumentLinksV4(state), inventory);
    assert.deepEqual(inspectPersistedNativeCollaborationSnapshot(state, (doc, actualSnapshot) => {
      const actual = inspectNativeDocumentLinksV4(doc, actualSnapshot);
      assertPlainLinks(doc, actual, standard, [
        { kind: 'markdown', syntax: 'inline-link', literal: 'target.md#Part', targetPathText: 'target.md',
          fragment: 'Part', raw: '[Visible](target.md#Part)' },
        { kind: 'wiki', syntax: 'wiki-link', literal: 'Wiki#Heading', targetPathText: 'Wiki',
          fragment: 'Heading', alias: 'Alias', raw: '[[Wiki#Heading|Alias]]' },
        { kind: 'markdown', syntax: 'inline-image', literal: 'image.png', targetPathText: 'image.png', raw: '![Image](image.png)' },
      ]);
      return actual;
    }), inventory);
  } finally { standardDoc.destroy(); }
  groups++;

  // Both target and entire syntax references use original UTF-16 coordinates.
  for (const bom of ['', '\uFEFF']) for (const newline of ['\n', '\r\n']) {
    const source = `${bom}# 😀 Heading${newline}${newline}😀 [Résumé](dir/😀.md#Part)${newline}`
      + `[[Note#^block|<img src="literal.png">]]${newline}`;
    const doc = createPlainTextYDoc(source);
    try {
      const { inventory } = readInventory(doc);
      assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
      assertPlainLinks(doc, inventory, source, [
        { kind: 'markdown', syntax: 'inline-link', literal: 'dir/😀.md#Part', targetPathText: 'dir/😀.md',
          fragment: 'Part', raw: '[Résumé](dir/😀.md#Part)' },
        { kind: 'wiki', syntax: 'wiki-link', literal: 'Note#^block', targetPathText: 'Note', fragment: '^block',
          alias: '<img src="literal.png">', raw: '[[Note#^block|<img src="literal.png">]]' },
      ]);
    } finally { doc.destroy(); }
  }
  groups++;

  // Literal Wiki aliases cannot manufacture HTML resources or Markdown targets.
  for (const alias of ['<img src="literal.png">', '<span>😀 Alias</span>']) {
    const raw = `[[Note|${alias}]]`, doc = createPlainTextYDoc(raw);
    try {
      const { inventory } = readInventory(doc);
      assertPlainLinks(doc, inventory, raw, [
        { kind: 'wiki', syntax: 'wiki-link', literal: 'Note', targetPathText: 'Note', alias, raw },
      ]);
      assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
      assert(!inventory.links.some(link => ['literal.png', 'fake.md', 'fake.png'].includes(link.targetPathText)));
    } finally { doc.destroy(); }
  }
  // The existing Wiki grammar excludes closing brackets inside its inner value.
  // This bracketed text is therefore ordinary Markdown, with two actual targets.
  const bracketAlias = '[[Note|[Alias](fake.md) ![Image](fake.png)]]';
  const bracketAliasDoc = createPlainTextYDoc(bracketAlias);
  try {
    const { inventory } = readInventory(bracketAliasDoc);
    assertPlainLinks(bracketAliasDoc, inventory, bracketAlias, [
      { kind: 'markdown', syntax: 'inline-link', literal: 'fake.md', targetPathText: 'fake.md', raw: '[Alias](fake.md)' },
      { kind: 'markdown', syntax: 'inline-image', literal: 'fake.png', targetPathText: 'fake.png', raw: '![Image](fake.png)' },
    ]);
    assert(!inventory.links.some(link => link.kind === 'wiki'));
    assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
  } finally { bracketAliasDoc.destroy(); }
  groups++;

  // Captured relative positions continue to identify the same targets and syntax
  // after a real prefix insertion; stored numeric facts remain original offsets.
  const original = '\uFEFF😀 [One](same.md) [[Note|<img src="literal.png">]] [Two](same.md)';
  const prefixDoc = createPlainTextYDoc(original);
  try {
    const { inventory } = readInventory(prefixDoc), saved = JSON.stringify(inventory.links);
    assert.equal(inventory.links.length, 3);
    assert.equal(new Set(inventory.links.map(link => link.id)).size, 3);
    const prefix = '😀 Prefix\r\n'; prefixDoc.getText('content').insert(0, prefix);
    assert.equal(prefixDoc.getText('content').toString(), prefix + original);
    for (const link of inventory.links) {
      assert.equal(link.ref.kind, 'plain-target');
      if (link.ref.kind !== 'plain-target') throw new Error('Expected plain relative references');
      assert.deepEqual(absoluteRange(prefixDoc, link.ref.text), {
        start: prefix.length + link.ref.targetStart, end: prefix.length + link.ref.targetEnd, value: link.ref.expected,
      });
      assert.deepEqual(absoluteRange(prefixDoc, link.ref.syntaxText), {
        start: prefix.length + link.ref.syntaxStart, end: prefix.length + link.ref.syntaxEnd, value: link.ref.raw,
      });
    }
    assert.equal(JSON.stringify(inventory.links), saved);
  } finally { prefixDoc.destroy(); }
  groups++;

  // YAML literal headings/block IDs stay outside body metadata and link grammar.
  const frontmatter = '\uFEFF---\ntitle: Explicit 😀\naliases: [Shared]\ntags: [native]\nexample: |\n'
    + '  # Hidden heading\n  Hidden ^yaml-block\n  [[Hidden]] <img src="hidden.png">\n---\n\n'
    + '# Body Heading\nBody ^body-block\n\n[Visible](visible.md)\n';
  const metadataDoc = createPlainTextYDoc(frontmatter);
  try {
    const { inventory } = readInventory(metadataDoc);
    assert.deepEqual(inventory.metadata, { path: 'Notes/Source.md', title: 'Explicit 😀', hasExplicitTitle: true,
      aliases: ['Shared'], tags: ['native'], headings: [{ depth: 1, text: 'Body Heading' }], blockIds: ['body-block'] });
    assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
    assertPlainLinks(metadataDoc, inventory, frontmatter, [
      { kind: 'markdown', syntax: 'inline-link', literal: 'visible.md', targetPathText: 'visible.md', raw: '[Visible](visible.md)' },
    ]);
  } finally { metadataDoc.destroy(); }
  groups++;

  // With no frontmatter, one initial BOM is excluded only from metadata parsing.
  const bomHeadingDoc = createPlainTextYDoc('\uFEFF# Heading\nText');
  try {
    const { inventory } = readInventory(bomHeadingDoc);
    assert.deepEqual(inventory.metadata.headings, [{ depth: 1, text: 'Heading' }]);
    assert.equal(inventory.metadata.title, 'Heading'); assert.equal(inventory.metadata.hasExplicitTitle, false);
    assert.deepEqual(inventory.metadata.blockIds, []);
    assert.equal(bomHeadingDoc.getText('content').toString(), '\uFEFF# Heading\nText');
  } finally { bomHeadingDoc.destroy(); }
  groups++;

  // Real HTML in Markdown labels and opaque standalone HTML remain coverage gaps.
  for (const [source, raws, targets] of [
    ['[<img src="asset.png">](keep.md)', ['<img src="asset.png">'], ['asset.png']],
    ['<custom-element resource="hidden.png">Body</custom-element>',
      ['<custom-element resource="hidden.png">', '</custom-element>'], []],
    ['[<custom-element resource="hidden.png">Label</custom-element>](keep.md)',
      ['<custom-element resource="hidden.png">', '</custom-element>'], []],
  ] as const) {
    const doc = createPlainTextYDoc(source);
    try {
      const { inventory } = readInventory(doc);
      assert.equal(inventory.coverage.complete, false);
      assert.deepEqual(inventory.coverage.gaps.map(gap => gap.code), raws.map(() => 'uninspected-html'));
      assert.deepEqual(inventory.coverage.gaps.map(gap => gap.raw), [...raws]);
      assert.deepEqual(inventory.coverage.gaps.flatMap(gap => gap.htmlTargets ?? []), [...targets]);
      assert(inventory.coverage.gaps.every(gap => gap.path === 'Notes/Source.md'));
      if (source.startsWith('[')) assertPlainLinks(doc, inventory, source, [
        { kind: 'markdown', syntax: 'inline-link', literal: 'keep.md', targetPathText: 'keep.md', raw: source },
      ]);
      else assert.deepEqual(inventory.links, []);
    } finally { doc.destroy(); }
  }
  groups++;

  // Empty text and excluded code/comment literals do not invent HTML gaps or links.
  for (const source of ['', '# No links\nText 😀', '`[[Code]] <img src="code.png">`\n\n'
    + '```md\n[[Fence]] <img src="fence.png">\n```\n\n%% [[Comment]] <img src="comment.png"> %%']) {
    const doc = createPlainTextYDoc(source);
    try {
      const { inventory } = readInventory(doc);
      assert.deepEqual(inventory.links, []); assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
    } finally { doc.destroy(); }
  }
  groups++;

  // Existing real XML/Blocks fixtures use their native nodes/marks, not Markdown.
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const doc = nativeRichDocumentFixture({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Native 😀' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'A\tB\r\n😀',
        marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'target.md#Part' } }] }] },
    ] }, representation);
    try {
      const { inventory, snapshot } = readInventory(doc, representation);
      assert.deepEqual(inventory, { ...inspectNativeDocumentLinks(doc, snapshot), parserVersion: 4 });
      assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
      assert.deepEqual(inventory.metadata.headings, [{ depth: 2, text: 'Native 😀' }]);
      assert.equal(inventory.links.length, 1); assert.equal(inventory.links[0].ref.kind, 'link-mark');
      assert.equal(inventory.links[0].targetPathText, 'target.md'); assert.equal(inventory.links[0].fragment, 'Part');
      assert.equal(snapshot.content.kind, 'rich_text');
    } finally { doc.destroy(); }
  }
  groups++;

  // Native-only table widths stay inspectable without portable Markdown export.
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const doc = nativeTableWidthFixture(representation);
    try {
      const { inventory, snapshot } = readInventory(doc, representation);
      assert.deepEqual(inventory, { ...inspectNativeDocumentLinks(doc, snapshot), parserVersion: 4 });
      assert.deepEqual(inventory.coverage, { complete: true, gaps: [] });
      assert.equal(inventory.links.length, 1); assert.equal(inventory.links[0].targetPathText, 'target.md');
      assert.equal(inventory.links[0].ref.kind, 'link-mark');
      assert.match(JSON.stringify(snapshot.content), /"colwidth":\[120\]/u);
    } finally { doc.destroy(); }
  }
  groups++;

  // Parser-4 output exhaustion fails closed before any partial link list escapes.
  for (const source of ['[[Note]] '.repeat(20_001), '[Note](note.md) '.repeat(20_001)]) {
    assert(Buffer.byteLength(source, 'utf8') < MAX_INDEXED_MARKDOWN_BYTES);
    const doc = createPlainTextYDoc(source);
    try {
      const { inventory } = readInventory(doc);
      assert.deepEqual(inventory.links, []);
      assert.deepEqual(inventory.coverage, { complete: false, gaps: [{ code: 'limit-exceeded', path: 'Notes/Source.md' }] });
    } finally { doc.destroy(); }
    groups++;
  }

  assert.equal(groups, 12);
  console.log(JSON.stringify({ suite: 'workspace-native-link-inventory-v4', groups,
    actualYjs: true, actualSnapshots: true, pureInventoryOnly: true }));
}
