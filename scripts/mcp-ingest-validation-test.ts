import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIRECT_MCP_INGEST_MAX_BINARY_BYTES,
  DIRECT_MCP_INGEST_MAX_TEXT_BYTES,
  DirectMcpIngestValidationError,
  encodeDirectMcpTextContent,
  isDirectMcpTextPath,
  validateDirectMcpIngestContent,
} from '../app/lib/mcp/server/ingest-validation';

function hasCode(code: string) {
  return (error: unknown) => error instanceof DirectMcpIngestValidationError && error.code === code;
}

function validate(markdown: string, source: 'generated' | 'uploaded' = 'generated', filePath = 'notes/example.md') {
  return validateDirectMcpIngestContent({ path: filePath, content: Buffer.from(markdown), source });
}

test('generated complex Markdown uses the Canvas editor codec without rewriting source', async () => {
  const markdown = [
    '---', 'title: MCP import', 'tags:', '  - type/report', '  - topic/mcp', '---', '',
    '# MCP import', '', 'A **bold** paragraph with [a link](https://example.com).', '',
    '- First item', '- Second item', '', '- [ ] A task', '',
    '| Name | Value |', '| --- | --- |', '| Canvas | Notebook |', '',
    '```ts', 'const title = "Canvas";', '```', '',
    '> [!note] Note', '> Original content is preserved.', '',
    '$E = mc^2$', '', '![Photo](assets/photo.png)', '',
  ].join('\n');
  const content = encodeDirectMcpTextContent(markdown);
  const before = Buffer.from(content);
  const result = await validateDirectMcpIngestContent({ path: 'notes/example.md', content, source: 'generated' });
  assert.equal(result.mimeType, 'text/markdown');
  assert.ok(result.markdown);
  assert.notEqual(result.markdown.mode, 'source');
  assert.deepEqual(content, before);
});

test('new Markdown rejects broken metadata while original imports preserve it with a warning', async () => {
  for (const markdown of ['---\ntitle: [\n---\n# Body\n', '---\ntitle: Unclosed\n', '---\n- list\n---\nBody']) {
    await assert.rejects(validate(markdown), hasCode('invalid_frontmatter'));
    const original = Buffer.from(markdown);
    const result = await validateDirectMcpIngestContent({ path: 'notes/original.md', content: original, source: 'uploaded' });
    assert.deepEqual(result.markdown, { mode: 'source', reason: 'invalid_frontmatter' });
    assert.ok(result.warnings.some(warning => warning.code === 'invalid_frontmatter'));
    assert.equal(original.toString('utf8'), markdown);
  }
});

test('UTF-8, NUL, surrogate and byte limits prevent silent text corruption', async () => {
  await assert.rejects(validateDirectMcpIngestContent({ path: 'note.md', content: Buffer.from([0xc3, 0x28]), source: 'uploaded' }), hasCode('invalid_utf8'));
  await assert.rejects(validate('A\u0000B'), hasCode('invalid_text'));
  assert.throws(() => encodeDirectMcpTextContent('Before\ud800After'), hasCode('invalid_utf8'));
  assert.throws(() => encodeDirectMcpTextContent('\udc00'), hasCode('invalid_utf8'));
  assert.equal(encodeDirectMcpTextContent('Valid emoji: 📝').toString('utf8'), 'Valid emoji: 📝');
  await assert.rejects(validateDirectMcpIngestContent({ path: 'note.txt', content: Buffer.alloc(DIRECT_MCP_INGEST_MAX_TEXT_BYTES + 1, 65), source: 'uploaded' }), hasCode('content_too_large'));
  assert.throws(() => encodeDirectMcpTextContent('ä'.repeat(DIRECT_MCP_INGEST_MAX_TEXT_BYTES)), hasCode('content_too_large'));
  const limit = Buffer.alloc(DIRECT_MCP_INGEST_MAX_TEXT_BYTES, 65);
  assert.equal((await validateDirectMcpIngestContent({ path: 'note.txt', content: limit, source: 'uploaded' })).mimeType, 'text/plain');
});

test('original source-only Markdown retains BOM, CRLF and final newline bytes', async () => {
  const markdown = '\uFEFF---\r\ntitle: Original\r\n---\r\n\r\n# Original\r\n\r\n<div>keep exactly</div>\r\n';
  const content = Buffer.from(markdown);
  const before = Buffer.from(content);
  const result = await validateDirectMcpIngestContent({ path: 'original.MARKDOWN', content, source: 'uploaded', mimeType: 'text/markdown; charset=utf-8' });
  assert.equal(result.mimeType, 'text/markdown');
  assert.equal(result.markdown?.mode, 'source');
  assert.ok(result.warnings.length);
  assert.deepEqual(content, before);
  assert.equal(content.toString('utf8'), markdown);
});

test('safe formatting normalization is reported without changing submitted text', async () => {
  const markdown = '1. First\n\n2. Second\n';
  const content = Buffer.from(markdown);
  const result = await validateDirectMcpIngestContent({ path: 'note.md', content, source: 'generated' });
  assert.equal(result.markdown?.mode, 'normalizable');
  assert.ok(result.warnings.some(warning => warning.code === 'rich_normalization_available'));
  assert.equal(content.toString('utf8'), markdown);
});

test('source compatibility and lint diagnostics do not reject code examples', async () => {
  const malformedTable = '| A | B |\n| --- | --- |\n| one | two | extra |';
  const codeExample = `# Table example\n\n\`\`\`markdown\n${malformedTable}\n\`\`\`\n`;
  const result = await validate(codeExample);
  assert.ok(!result.warnings.some(warning => warning.code === 'markdown-tables'));
  const linted = await validate(`# Table\n\n${malformedTable}\n`);
  assert.ok(linted.warnings.some(warning => warning.code === 'markdown-tables'));
  const sourceOnly = await validate('%% hidden comment %%\n\nText\n');
  assert.deepEqual(sourceOnly.markdown, { mode: 'source', reason: 'unsupported_obsidian_syntax' });
});

test('generated runaway slash sequences fail while original files return diagnostics', async () => {
  const markdown = '/'.repeat(230);
  await assert.rejects(validate(markdown), hasCode('unsafe_slash_run'));
  const result = await validate(markdown, 'uploaded');
  assert.deepEqual(result.markdown, { mode: 'source', reason: 'unsafe_slash_run' });
  assert.ok(result.warnings.some(warning => warning.code === 'unsafe_slash_run'));
});

test('SVG is UTF-8 text without rich Markdown assumptions and MIME contradictions fail', async () => {
  assert.equal(isDirectMcpTextPath('assets/ICON.SVG'), true);
  assert.equal(isDirectMcpTextPath('notes/example.markdown'), true);
  assert.equal(isDirectMcpTextPath('assets/photo.png'), false);
  const svg = await validate('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" /></svg>', 'uploaded', 'assets/icon.svg');
  assert.equal(svg.mimeType, 'image/svg+xml');
  assert.equal(svg.markdown, null);
  await assert.rejects(validateDirectMcpIngestContent({ path: 'note.md', content: Buffer.from('Text'), source: 'uploaded', mimeType: 'image/png' }), hasCode('mime_type_mismatch'));
  await assert.rejects(validateDirectMcpIngestContent({ path: 'note.md', content: Buffer.from('Text'), source: 'uploaded', mimeType: 'invalid' }), hasCode('invalid_mime_type'));
});

test('binary signatures enforce declared MIME and arbitrary files remain importable', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT6cAAAAASUVORK5CYII=', 'base64');
  const detected = await validateDirectMcpIngestContent({ path: 'photo.png', content: png, source: 'uploaded' });
  assert.equal(detected.mimeType, 'image/png');
  assert.equal(detected.markdown, null);
  await assert.rejects(validateDirectMcpIngestContent({ path: 'photo.jpg', content: png, source: 'uploaded', mimeType: 'image/jpeg' }), hasCode('mime_type_mismatch'));
  await assert.rejects(validateDirectMcpIngestContent({ path: 'photo.png', content: png, source: 'uploaded', mimeType: 'text/plain' }), hasCode('mime_type_mismatch'));
  const unknown = await validateDirectMcpIngestContent({ path: 'original.dat', content: Buffer.from([0, 1, 2, 128, 255]), source: 'uploaded' });
  assert.equal(unknown.mimeType, 'application/octet-stream');
  assert.deepEqual(unknown.warnings, []);
  await assert.rejects(validateDirectMcpIngestContent({ path: 'original.dat', content: Buffer.alloc(DIRECT_MCP_INGEST_MAX_BINARY_BYTES + 1), source: 'uploaded' }), hasCode('content_too_large'));
});
