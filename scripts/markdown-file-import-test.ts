import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { MARKDOWN_FILE_IMPORT_LIMIT, MarkdownFileImportError, prepareMarkdownFileImport } from '../app/lib/collaboration/markdown-file-import';
import { serializeCanonicalText } from '../app/lib/collaboration/persistence';

for (const [name, source] of [
  ['LF', '---\ntitle: Complete file\n---\n\n# Heading\n'],
  ['BOM/CRLF', '\uFEFF---\r\ntitle: Complete file\r\n---\r\n\r\n# Heading\r\n'],
] as const) test(`${name}: both Rich formats retain the entire file and exact byte profile`, () => {
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const prepared = prepareMarkdownFileImport(Buffer.from(source), { representation });
    const snapshot = authoritativeNativeCollaborationSnapshot({ documentId: 'import-test', workspaceId: 'workspace-test', organizationId: null,
      path: 'note.md', representation, lifecycleGeneration: 1, schemaVersion: 1, yjsState: prepared.yjsState,
      stateVector: prepared.stateVector, documentSequence: 0, persistedAt: 1, checkpointedAt: null, checkpointSequence: 0,
      canonicalHash: null, serializedHash: null, newlineStyle: prepared.newlineStyle, hasBom: prepared.hasBom, degraded: false, status: 'active' });
    assert.equal(snapshot.content.kind, 'rich_text');
    if (snapshot.content.kind === 'rich_text') {
      assert.equal(snapshot.content.frontmatter, '---\ntitle: Complete file\n---\n\n');
      assert.equal(snapshot.content.bodyFinalLineEnding, '\n');
    }
    assert.equal(serializeCanonicalText(prepared.canonical, prepared), source);
  }
});

for (const [name, source] of [
  ['normalizable Markdown', '*odd* spacing  \n'],
  ['invalid frontmatter', '---\ninvalid: [\n---\ntext\n'],
  ['HTML/Obsidian source', '<div data-future="preserve">text</div>\n'],
  ['tab and Unicode', 'A\tB😀\n'],
] as const) test(`${name}: auto chooses exact Plain/Source, without applying normalization`, () => {
  const prepared = prepareMarkdownFileImport(Buffer.from(source));
  assert.equal(prepared.representation, 'plain_text'); assert.ok(prepared.sourceFallbackReason);
  assert.equal(prepared.canonical, source); assert.equal(serializeCanonicalText(prepared.canonical, prepared), source);
  assert.throws(() => prepareMarkdownFileImport(Buffer.from(source), { representation: 'tiptap_blocks' }),
    error => error instanceof MarkdownFileImportError && error.code === 'MARKDOWN_IMPORT_RICH_UNAVAILABLE');
});
test('invalid UTF8, mixed/bare-CR endings and oversized files reject before native allocation', () => {
  for (const source of [new Uint8Array([0xc3, 0x28]), Buffer.from('A\rB'), Buffer.from('A\r\nB\n')]) {
    assert.throws(() => prepareMarkdownFileImport(source), error => error instanceof MarkdownFileImportError
      && error.code === 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED');
  }
  assert.throws(() => prepareMarkdownFileImport(new Uint8Array(MARKDOWN_FILE_IMPORT_LIMIT + 1)),
    error => error instanceof MarkdownFileImportError && error.code === 'MARKDOWN_IMPORT_INVALID_INPUT');
});
test('empty file, BOM-only file and explicit Source remain byte-exact', () => {
  for (const source of ['', '\uFEFF', '# Heading\n']) {
    const prepared = prepareMarkdownFileImport(Buffer.from(source), { representation: 'plain_text' });
    assert.equal(prepared.representation, 'plain_text'); assert.equal(serializeCanonicalText(prepared.canonical, prepared), source);
  }
  assert.equal(prepareMarkdownFileImport(new Uint8Array()).representation, 'tiptap_blocks');
  const emptyXml = prepareMarkdownFileImport(new Uint8Array(), { representation: 'tiptap_xml' });
  assert.equal(emptyXml.representation, 'tiptap_xml');
  assert.equal(emptyXml.canonical, '');
  assert.equal(emptyXml.sourceFallbackReason, undefined);
  assert.deepEqual(emptyXml.yjsState, Uint8Array.of(0, 0));
  assert.deepEqual(emptyXml.stateVector, Uint8Array.of(0));
});
